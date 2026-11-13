#!/usr/bin/env bash
# Merges louislam/uptime-kuma into this fork's branches, for the Fork Sync workflow:
#
#   upstream master -> master (fast-forward only, master is a pure mirror)
#   master -> each feature branch
#   master, then each feature branch -> docker-build
#
# The merges are made with git merge-tree and git commit-tree, so the working tree and the
# local branches are left alone, and nothing is pushed. The new branch tips are written as
# step outputs. On a conflict it writes what conflicted to the "problem" output and exits 1.
#
# The push job runs it again with START and MERGE_DATE from the tested run, which makes the
# same commits again, and EXPECT, the tested run's result, to check that it did.
set -euo pipefail
shopt -s inherit_errexit

# The long-lived feature branches, merged into docker-build in this order
features=(backup-restore ui-size)
branches=(master "${features[@]}" docker-build)
out=${GITHUB_OUTPUT:-/dev/stderr}
summary=${GITHUB_STEP_SUMMARY:-/dev/stderr}

# A fixed identity and date, so the same merges always give the same commits
export GIT_AUTHOR_NAME="github-actions[bot]"
export GIT_AUTHOR_EMAIL="41898282+github-actions[bot]@users.noreply.github.com"
export GIT_COMMITTER_NAME=$GIT_AUTHOR_NAME GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL
merge_date=${MERGE_DATE:-$(date +%s)}
export GIT_AUTHOR_DATE="$merge_date +0000" GIT_COMMITTER_DATE="$merge_date +0000"

# stop <reason>: reports why the sync can't go on, and exits
stop() {
    echo "problem=$1" >> "$out"
    printf '### Fork sync stopped\n\n%s\n' "$1" >> "$summary"
    echo "::error::$1" >&2
    exit 1
}

# merge <from> <into>: prints the commit that branch <into> becomes after merging <from>
merge() {
    local from=${tip[$1]} into=${tip[$2]} tree status=0
    if git merge-base --is-ancestor "$from" "$into"; then
        echo "$into" # already merged
    elif git merge-base --is-ancestor "$into" "$from"; then
        echo "$from" # fast-forward, like git merge
    else
        tree=$(git merge-tree --write-tree --name-only --no-messages "$into" "$from") || status=$?
        if ((status == 1)); then
            # On a conflict, merge-tree lists the conflicted files after the tree
            stop "Merging $1 into $2 conflicts in $(tail -n +2 <<< "$tree" | sort -u | paste -sd ' ')"
        fi
        ((status == 0)) || exit "$status"
        git commit-tree "$tree" -p "$into" -p "$from" -m "Merge branch '$1' into $2"
    fi
}

declare -A start tip
git fetch --quiet --no-tags "${UPSTREAM_URL:-https://github.com/louislam/uptime-kuma.git}" master
start[upstream]=$(git rev-parse FETCH_HEAD)
refspecs=()
for branch in "${branches[@]}"; do
    refspecs+=("+refs/heads/$branch:refs/remotes/origin/$branch")
done
git fetch --quiet --no-tags origin "${refspecs[@]}"
for branch in "${branches[@]}"; do
    start[$branch]=$(git rev-parse "refs/remotes/origin/$branch")
done

# START pins the starting commits, as "upstream=<sha> master=<sha> ..."
read -ra pairs <<< "${START:-}"
for pair in "${pairs[@]}"; do
    start[${pair%%=*}]=${pair#*=}
done

for branch in "${branches[@]}"; do
    tip[$branch]=${start[$branch]}
done
if ! git merge-base --is-ancestor "${start[master]}" "${start[upstream]}"; then
    stop "master has commits that upstream master doesn't, so it can't be fast-forwarded"
fi
tip[master]=${start[upstream]}
for branch in "${features[@]}"; do
    tip[$branch]=$(merge master "$branch")
done
for branch in master "${features[@]}"; do
    tip[docker-build]=$(merge "$branch" docker-build)
done

started="upstream=${start[upstream]}"
result=()
push=()
changed=false
printf '| Branch | Was | Now | New commits |\n| --- | --- | --- | --- |\n' >> "$summary"
for branch in "${branches[@]}"; do
    started+=" $branch=${start[$branch]}"
    result+=("$branch=${tip[$branch]}")
    if [[ ${tip[$branch]} != "${start[$branch]}" ]]; then
        changed=true
        push+=("${tip[$branch]}:refs/heads/$branch")
    fi
    printf '| %s | %.8s | %.8s | %s |\n' "$branch" "${start[$branch]}" "${tip[$branch]}" \
        "$(git rev-list --count "${start[$branch]}..${tip[$branch]}")" >> "$summary"
done

if [[ -n ${EXPECT:-} && ${result[*]} != "$EXPECT" ]]; then
    echo "::error::These merges came out different from the tested ones: ${result[*]}" >&2
    exit 1
fi

{
    echo "changed=$changed"
    echo "start=$started"
    echo "result=${result[*]}"
    echo "push=${push[*]}"
    echo "merge_date=$merge_date"
    echo "docker_build=${tip[docker-build]}"
} >> "$out"
