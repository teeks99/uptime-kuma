<template>
    <div ref="modal" class="modal fade" tabindex="-1">
        <div class="modal-dialog">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title">
                        {{ $t("eventExportTitle") }}
                    </h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal" :aria-label="$t('Close')" />
                </div>
                <div class="modal-body">
                    <div class="mb-3">
                        <label for="event-export-period" class="form-label">{{ $t("eventExportHistory") }}</label>
                        <select
                            id="event-export-period"
                            v-model="period"
                            class="form-select"
                            data-testid="event-export-period"
                        >
                            <option v-for="hours in periods" :key="hours" :value="hours">
                                {{ periodName(hours) }}
                            </option>
                        </select>
                    </div>
                    <div>
                        <label for="event-export-format" class="form-label">{{ $t("eventExportFormat") }}</label>
                        <select
                            id="event-export-format"
                            v-model="format"
                            class="form-select"
                            data-testid="event-export-format"
                        >
                            <option value="json">JSON</option>
                            <option value="csv">CSV</option>
                        </select>
                    </div>
                    <div v-if="leaveOutGroupEvents" class="form-text mt-3" data-testid="event-export-group-note">
                        {{ $t("eventExportGroupEventsHidden") }}
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">
                        {{ $t("Cancel") }}
                    </button>
                    <button
                        type="button"
                        class="btn btn-primary"
                        :disabled="processing"
                        data-testid="event-export-confirm"
                        @click="exportEvents"
                    >
                        <div v-if="processing" class="spinner-border spinner-border-sm me-1"></div>
                        {{ $t("Export") }}
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
import { Modal } from "bootstrap";
import {
    EVENT_EXPORT_DEFAULT_FORMAT,
    EVENT_EXPORT_DEFAULT_PERIOD,
    EVENT_EXPORT_FORMATS,
    EVENT_EXPORT_PERIODS,
    collectEventHeartbeats,
    eventExportFileName,
    eventExportStart,
    eventsToCSV,
    eventsToJSON,
    toExportedEvents,
} from "../event-export.ts";

/** How long the server may take to answer with one page of events */
const PAGE_TIMEOUT_MS = 30000;

/**
 * Exports the events of the dashboard's event list (the important heartbeats of all monitors) as a file.
 * The server has no export of its own: the dialog collects the events through the paged list
 * the event list uses, and builds the file in the browser.
 */
export default {
    props: {
        /** The event list hides the events of group monitors */
        hideGroupEvents: {
            type: Boolean,
            default: false,
        },
    },
    data() {
        // The dialog opens with what was exported the last time
        const lastPeriod = Number(localStorage.getItem("eventExportPeriod") ?? EVENT_EXPORT_DEFAULT_PERIOD);
        const lastFormat = localStorage.getItem("eventExportFormat");

        return {
            modal: null,
            processing: false,
            periods: EVENT_EXPORT_PERIODS,
            period: EVENT_EXPORT_PERIODS.includes(lastPeriod) ? lastPeriod : EVENT_EXPORT_DEFAULT_PERIOD,
            format: EVENT_EXPORT_FORMATS.includes(lastFormat) ? lastFormat : EVENT_EXPORT_DEFAULT_FORMAT,
        };
    },
    computed: {
        /**
         * Without a group monitor there is nothing to leave out, and the list has no switch for it either
         * @returns {boolean} True if the export leaves out the events of group monitors
         */
        leaveOutGroupEvents() {
            return (
                this.hideGroupEvents &&
                Object.values(this.$root.monitorList).some((monitor) => monitor.type === "group")
            );
        },
    },
    mounted() {
        this.modal = new Modal(this.$refs.modal);
    },
    beforeUnmount() {
        if (this.modal) {
            this.modal.hide();
        }
    },
    methods: {
        /**
         * Show the dialog
         * @returns {void}
         */
        show() {
            this.modal.show();
        },

        /**
         * Name of a history choice
         * @param {number} hours Length of the period in hours, 0 for everything
         * @returns {string} Name shown in the list
         */
        periodName(hours) {
            if (hours === 0) {
                return this.$t("eventExportEverything");
            }
            if (hours % 24 === 0 && hours > 24) {
                return this.$t("days", hours / 24);
            }
            return this.$t("hours", hours);
        },

        /**
         * Get one page of the important heartbeats of all monitors, newest first
         * @param {number} offset Number of heartbeats to skip
         * @param {number} count Number of heartbeats to get
         * @returns {Promise<object[]>} Heartbeats
         */
        fetchPage(offset, count) {
            return new Promise((resolve, reject) => {
                this.$root
                    .getSocket()
                    .timeout(PAGE_TIMEOUT_MS)
                    .emit("monitorImportantHeartbeatListPaged", null, offset, count, (error, res) => {
                        if (error) {
                            reject(error);
                        } else if (!res.ok) {
                            reject(new Error(res.msg));
                        } else {
                            resolve(res.data);
                        }
                    });
            });
        },

        /**
         * Collect the events and hand them to the browser as a file
         * @returns {Promise<void>}
         */
        async exportEvents() {
            this.processing = true;

            try {
                const now = new Date();
                const from = eventExportStart(this.period, now);
                const heartbeats = await collectEventHeartbeats(this.fetchPage, from);
                const events = toExportedEvents(heartbeats, this.$root.monitorList, this.leaveOutGroupEvents);

                if (events.length === 0) {
                    this.$root.toastRes({ ok: false, msg: "eventExportEmpty", msgi18n: true });
                    return;
                }

                if (this.format === "csv") {
                    // The times of the event list, in the timezone the dashboard shows
                    const content = eventsToCSV(events, (time) => this.$root.datetime(time), this.$root.timezone);
                    this.download(content, "text/csv;charset=utf-8", eventExportFileName("csv", now));
                } else {
                    const content = eventsToJSON(events, {
                        exportedAt: now,
                        from,
                        hideGroupEvents: this.leaveOutGroupEvents,
                    });
                    this.download(content, "application/json", eventExportFileName("json", now));
                }

                localStorage.setItem("eventExportPeriod", this.period);
                localStorage.setItem("eventExportFormat", this.format);

                this.modal.hide();
                this.$root.toastRes({ ok: true, msg: this.$t("eventExportDone", events.length) });
            } catch (e) {
                this.$root.toastRes({ ok: false, msg: this.$t("eventExportFailed", [e.message]) });
            } finally {
                this.processing = false;
            }
        },

        /**
         * Make the browser save a text as a file
         * @param {string} content Content of the file
         * @param {string} type Media type of the file
         * @param {string} fileName Name of the file
         * @returns {void}
         */
        download(content, type, fileName) {
            const url = URL.createObjectURL(new Blob([content], { type }));
            const link = document.createElement("a");
            link.href = url;
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            link.remove();
            // The download has started by now, the browser no longer needs the URL
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        },
    },
};
</script>
