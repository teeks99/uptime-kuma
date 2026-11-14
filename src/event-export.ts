import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";

dayjs.extend(utc);

/**
 * Export of the dashboard's event list (the important heartbeats) as a file.
 * Everything here is free of Vue and of the socket, so it can be tested on its own.
 */

/** History choices of the export dialog in hours, 0 means everything */
export const EVENT_EXPORT_PERIODS = [24, 168, 720, 2160, 8760, 0];
export const EVENT_EXPORT_DEFAULT_PERIOD = 720;

export const EVENT_EXPORT_FORMATS = ["json", "csv"] as const;
export type EventExportFormat = (typeof EVENT_EXPORT_FORMATS)[number];
export const EVENT_EXPORT_DEFAULT_FORMAT: EventExportFormat = "json";

/** Events requested from the server per call */
export const EVENT_EXPORT_PAGE_SIZE = 500;

const STATUS_NAMES = ["down", "up", "pending", "maintenance"];
const STATUS_LABELS = ["Down", "Up", "Pending", "Maintenance"];

/** An important heartbeat as the server sends it */
export interface EventHeartbeat {
    monitorID: number;
    status: number;
    /** UTC, like "2026-11-13 07:26:42.123" */
    time: string;
    msg?: string | null;
}

/** What the export needs to know about a monitor, a subset of the dashboard's monitor list */
export interface EventMonitor {
    name?: string;
    type?: string;
    parent?: number | null;
}

export interface ExportedEvent {
    /** ISO 8601 in UTC */
    time: string;
    /** Name of the group the monitor is in, null if it is in none */
    group: string | null;
    monitor: string;
    monitorID: number;
    /** A STATUS_NAMES entry, "unknown" otherwise */
    status: string;
    message: string;
}

export interface EventExportInfo {
    exportedAt: Date;
    /** Start of the exported period, null for everything */
    from: Date | null;
    hideGroupEvents: boolean;
}

/**
 * Start of the exported period
 * @param hours Length of the period in hours, 0 for everything
 * @param now End of the period
 * @returns Start of the period, null for everything
 */
export function eventExportStart(hours: number, now: Date = new Date()): Date | null {
    if (!(hours > 0)) {
        return null;
    }
    return new Date(now.getTime() - hours * 3600 * 1000);
}

/**
 * Collect the important heartbeats back to the start of the period.
 * The server only offers the list page by page, newest first, so this asks for pages until one reaches the start.
 * @param fetchPage Gets one page of the list: count heartbeats, skipping the newest offset ones
 * @param from Start of the period, null for everything
 * @param pageSize Heartbeats per page
 * @returns Heartbeats of the period, newest first
 */
export async function collectEventHeartbeats(
    fetchPage: (offset: number, count: number) => Promise<EventHeartbeat[]>,
    from: Date | null = null,
    pageSize: number = EVENT_EXPORT_PAGE_SIZE
): Promise<EventHeartbeat[]> {
    const fromTime = from ? from.getTime() : null;
    const heartbeats: EventHeartbeat[] = [];
    const seen = new Set<string>();

    for (let offset = 0; ; offset += pageSize) {
        const page = await fetchPage(offset, pageSize);
        let added = 0;

        for (const heartbeat of page) {
            if (fromTime !== null && dayjs.utc(heartbeat.time).valueOf() < fromTime) {
                return heartbeats;
            }

            // An event that arrives while the pages are fetched moves the list down by one,
            // so the next page starts with a heartbeat that the last one already had
            const key = `${heartbeat.monitorID} ${heartbeat.time} ${heartbeat.status}`;
            if (!seen.has(key)) {
                seen.add(key);
                heartbeats.push(heartbeat);
                added++;
            }
        }

        // A short page is the end of the list. A page without anything new would repeat forever.
        if (page.length < pageSize || added === 0) {
            return heartbeats;
        }
    }
}

/**
 * Turn important heartbeats into the events of the export, in the same order
 * @param heartbeats Important heartbeats
 * @param monitorList Monitors by ID, the dashboard's monitor list
 * @param hideGroupEvents Leave out the events of group monitors
 * @returns Events
 */
export function toExportedEvents(
    heartbeats: EventHeartbeat[],
    monitorList: Record<string, EventMonitor | undefined>,
    hideGroupEvents: boolean = false
): ExportedEvent[] {
    const events: ExportedEvent[] = [];

    for (const heartbeat of heartbeats) {
        const monitor = monitorList[heartbeat.monitorID];

        if (hideGroupEvents && monitor?.type === "group") {
            continue;
        }

        const group = monitor?.parent != null ? monitorList[monitor.parent] : undefined;

        events.push({
            time: dayjs.utc(heartbeat.time).toISOString(),
            group: group?.name ?? null,
            monitor: monitor?.name || `#${heartbeat.monitorID}`,
            monitorID: heartbeat.monitorID,
            status: STATUS_NAMES[heartbeat.status] ?? "unknown",
            message: heartbeat.msg ?? "",
        });
    }

    return events;
}

/**
 * The export as JSON
 * @param events Events
 * @param info What was exported
 * @returns Content of the file
 */
export function eventsToJSON(events: ExportedEvent[], info: EventExportInfo): string {
    return (
        JSON.stringify(
            {
                exportedAt: info.exportedAt.toISOString(),
                from: info.from ? info.from.toISOString() : null,
                hideGroupEvents: info.hideGroupEvents,
                events,
            },
            null,
            2
        ) + "\n"
    );
}

/**
 * One field of a CSV line
 * @param value Value of the field
 * @returns The field, quoted if it has to be
 */
export function csvField(value: string): string {
    let field = value;

    // The names and messages come from the monitored services. A spreadsheet would run a field
    // starting with one of these characters as a formula, the quote keeps it a text.
    if (/^[=+\-@\t\r]/.test(field)) {
        field = "'" + field;
    }

    if (/[",\r\n]/.test(field)) {
        field = '"' + field.replace(/"/g, '""') + '"';
    }

    return field;
}

/**
 * The export as CSV, with the columns of the event list
 * @param events Events
 * @param formatTime Turns the time of an event into the text of the time column
 * @param timeLabel Says in the header what the times are, e.g. the timezone
 * @returns Content of the file
 */
export function eventsToCSV(
    events: ExportedEvent[],
    formatTime: (time: string) => string = (time) => time,
    timeLabel: string = "UTC"
): string {
    const lines = [[`Time (${timeLabel})`, "Group", "Monitor", "Status", "Message"]];

    for (const event of events) {
        lines.push([
            formatTime(event.time),
            event.group ?? "",
            event.monitor,
            STATUS_LABELS[STATUS_NAMES.indexOf(event.status)] ?? "Unknown",
            event.message,
        ]);
    }

    // The byte order mark makes spreadsheets read the file as UTF-8
    return "﻿" + lines.map((line) => line.map(csvField).join(",") + "\r\n").join("");
}

/**
 * Name of the exported file
 * @param format Format of the file
 * @param now Time of the export
 * @returns File name, e.g. uptime-kuma-events-20261113-072642.json
 */
export function eventExportFileName(format: EventExportFormat, now: Date = new Date()): string {
    return `uptime-kuma-events-${dayjs(now).format("YYYYMMDD-HHmmss")}.${format}`;
}
