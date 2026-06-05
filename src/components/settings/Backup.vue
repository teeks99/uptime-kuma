<template>
    <div>
        <div class="my-4">
            <h3 class="mb-3">{{ $t("Backup") }}</h3>
            <p>{{ $t("Backup your specific monitors and configurations to a JSON file.") }}</p>
            <button class="btn btn-primary" type="button" @click="exportBackup">
                {{ $t("Backup to JSON") }}
            </button>
        </div>

        <hr />

        <div class="my-4">
            <h3 class="mb-3">{{ $t("Restore") }}</h3>
            <div class="alert alert-warning">
                <strong>{{ $t("Warning:") }}</strong> {{ $t("Importing a backup will merge the monitors and configurations into your current account. Ensure that you want to duplicate or recreate these items before proceeding.") }}
            </div>
            
            <div class="mb-3">
                <label for="restoreFile" class="form-label">{{ $t("Select JSON file") }}</label>
                <input class="form-control" type="file" id="restoreFile" accept=".json" @change="onFileChange" />
            </div>

            <button class="btn btn-danger" type="button" :disabled="!restoreData" @click="restoreBackup">
                {{ $t("Restore from JSON") }}
            </button>
        </div>
    </div>
</template>

<script>
export default {
    data() {
        return {
            restoreData: null,
        };
    },
    methods: {
        exportBackup() {
            this.$root.getSocket().emit("backupData", (res) => {
                if (res.ok) {
                    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(res.backup, null, 2));
                    const downloadAnchorNode = document.createElement("a");
                    downloadAnchorNode.setAttribute("href", dataStr);
                    downloadAnchorNode.setAttribute("download", "uptimekuma-backup.json");
                    document.body.appendChild(downloadAnchorNode);
                    downloadAnchorNode.click();
                    downloadAnchorNode.remove();
                } else {
                    this.$root.toastRes(res);
                }
            });
        },
        onFileChange(e) {
            const files = e.target.files;
            if (files.length === 0) {
                this.restoreData = null;
                return;
            }

            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    this.restoreData = JSON.parse(e.target.result);
                } catch (err) {
                    this.$root.toastError("Invalid JSON file");
                    this.restoreData = null;
                }
            };
            reader.readAsText(files[0]);
        },
        restoreBackup() {
            if (!this.restoreData) {
                return;
            }

            if (confirm(this.$t("Are you sure you want to restore? This will import monitors and settings into your account."))) {
                this.$root.getSocket().emit("restoreData", this.restoreData, (res) => {
                    this.$root.toastRes(res);
                    if (res.ok) {
                        this.restoreData = null;
                        document.getElementById("restoreFile").value = "";
                        
                        setTimeout(() => {
                            location.reload();
                        }, 2000);
                    }
                });
            }
        },
    },
};
</script>
