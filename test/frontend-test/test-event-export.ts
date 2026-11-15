import { describe, test } from "node:test";
import assert from "node:assert";
import {
    collectEventHeartbeats,
    csvField,
    eventExportFileName,
    eventExportStart,
    eventsToCSV,
    eventsToJSON,
    toExportedEvents,
} from "../../src/event-export";
import type { EventHeartbeat, ExportedEvent } from "../../src/event-export";

const monitorList = {
    1: { name: "Web cluster", type: "group", parent: null },
    2: { name: "web-1", type: "http", parent: 1 },
    3: { name: "Standalone API", type: "http", parent: null },
};

/**
 * Important heartbeats, one a minute, newest first like the server sends them
 * @param count Number of heartbeats
 * @param monitorID Monitor of the heartbeats
 * @returns Heartbeats
 */
function makeHeartbeats(count: number, monitorID = 2): EventHeartbeat[] {
    const newest = Date.UTC(2026, 10, 13, 12, 0, 0);
    const heartbeats: EventHeartbeat[] = [];

    for (let i = 0; i < count; i++) {
        heartbeats.push({
            monitorID,
            status: i % 2,
            time: new Date(newest - i * 60000).toISOString().replace("T", " ").replace("Z", ""),
            msg: `event ${i}`,
        });
    }

    return heartbeats;
}

/**
 * A server that pages through a list like monitorImportantHeartbeatListPaged does
 * @param list The whole list, newest first
 * @returns The page function and the calls made to it
 */
function pagedServer(list: EventHeartbeat[]) {
    const calls: number[][] = [];

    return {
        calls,
        fetchPage: async (offset: number, count: number) => {
            calls.push([offset, count]);
            return list.slice(offset, offset + count);
        },
    };
}

describe("eventExportStart()", () => {
    test("goes back the given number of hours", () => {
        const now = new Date("2026-11-13T12:00:00.000Z");

        assert.strictEqual(eventExportStart(24, now)?.toISOString(), "2026-11-12T12:00:00.000Z");
        assert.strictEqual(eventExportStart(720, now)?.toISOString(), "2026-10-14T12:00:00.000Z");
    });

    test("has no start for everything", () => {
        assert.strictEqual(eventExportStart(0), null);
    });
});

describe("collectEventHeartbeats()", () => {
    test("pages through the whole list", async () => {
        const list = makeHeartbeats(25);
        const server = pagedServer(list);

        const result = await collectEventHeartbeats(server.fetchPage, null, 10);

        assert.deepStrictEqual(result, list);
        assert.deepStrictEqual(server.calls, [
            [0, 10],
            [10, 10],
            [20, 10],
        ]);
    });

    test("asks once more when the last page is full", async () => {
        const list = makeHeartbeats(20);
        const server = pagedServer(list);

        const result = await collectEventHeartbeats(server.fetchPage, null, 10);

        assert.deepStrictEqual(result, list);
        assert.strictEqual(server.calls.length, 3);
    });

    test("returns nothing for an empty list", async () => {
        const server = pagedServer([]);

        assert.deepStrictEqual(await collectEventHeartbeats(server.fetchPage, null, 10), []);
        assert.strictEqual(server.calls.length, 1);
    });

    test("stops at the start of the period", async () => {
        const list = makeHeartbeats(50);
        const server = pagedServer(list);
        // Heartbeat 12 is exactly at the start and still belongs to the period
        const from = new Date(Date.UTC(2026, 10, 13, 12, 0, 0) - 12 * 60000);

        const result = await collectEventHeartbeats(server.fetchPage, from, 10);

        assert.deepStrictEqual(result, list.slice(0, 13));
        // The second page reaches the start, the rest of the list is never asked for
        assert.strictEqual(server.calls.length, 2);
    });

    test("leaves out a heartbeat it gets twice because a new event moved the list", async () => {
        const list = makeHeartbeats(25);
        const calls: number[][] = [];
        const fetchPage = async (offset: number, count: number) => {
            calls.push([offset, count]);
            if (calls.length === 2) {
                // A new event arrived after the first page
                list.unshift({ monitorID: 3, status: 0, time: "2026-11-13 12:00:30.000", msg: "new" });
            }
            return list.slice(offset, offset + count);
        };

        const result = await collectEventHeartbeats(fetchPage, null, 10);

        assert.strictEqual(result.length, 25);
        assert.strictEqual(new Set(result.map((heartbeat) => heartbeat.msg)).size, 25);
        assert.ok(!result.some((heartbeat) => heartbeat.msg === "new"));
    });

    test("stops when a server keeps sending the same page", async () => {
        const page = makeHeartbeats(10);
        let calls = 0;

        const result = await collectEventHeartbeats(
            async () => {
                calls++;
                return page;
            },
            null,
            10
        );

        assert.deepStrictEqual(result, page);
        assert.strictEqual(calls, 2);
    });
});

describe("toExportedEvents()", () => {
    const heartbeats: EventHeartbeat[] = [
        { monitorID: 2, status: 1, time: "2026-11-13 07:26:42.123", msg: "200 - OK" },
        { monitorID: 1, status: 1, time: "2026-11-13 07:26:42.100", msg: "All children up and running" },
        { monitorID: 3, status: 0, time: "2026-11-13 07:20:00.000", msg: null },
    ];

    test("names the monitor and its group, with the time in UTC", () => {
        assert.deepStrictEqual(toExportedEvents(heartbeats, monitorList), [
            {
                time: "2026-11-13T07:26:42.123Z",
                group: "Web cluster",
                monitor: "web-1",
                monitorID: 2,
                status: "up",
                message: "200 - OK",
            },
            {
                time: "2026-11-13T07:26:42.100Z",
                group: null,
                monitor: "Web cluster",
                monitorID: 1,
                status: "up",
                message: "All children up and running",
            },
            {
                time: "2026-11-13T07:20:00.000Z",
                group: null,
                monitor: "Standalone API",
                monitorID: 3,
                status: "down",
                message: "",
            },
        ]);
    });

    test("leaves out the events of group monitors when they are hidden", () => {
        const events = toExportedEvents(heartbeats, monitorList, true);

        assert.deepStrictEqual(
            events.map((event) => event.monitor),
            ["web-1", "Standalone API"]
        );
        // The events of the monitors in a group stay, with the name of their group
        assert.strictEqual(events[0].group, "Web cluster");
    });

    test("names every status", () => {
        const events = toExportedEvents(
            [0, 1, 2, 3, 9].map((status) => ({ monitorID: 3, status, time: "2026-11-13 07:00:00.000" })),
            monitorList
        );

        assert.deepStrictEqual(
            events.map((event) => event.status),
            ["down", "up", "pending", "maintenance", "unknown"]
        );
    });

    test("still exports the event of a monitor that is not in the list", () => {
        const events = toExportedEvents([{ monitorID: 99, status: 0, time: "2026-11-13 07:00:00.000" }], monitorList);

        assert.strictEqual(events[0].monitor, "#99");
        assert.strictEqual(events[0].group, null);
    });
});

describe("eventsToJSON()", () => {
    const events = toExportedEvents(
        [{ monitorID: 2, status: 0, time: "2026-11-13 07:26:42.000", msg: 'failed, "quoted"\nsecond line' }],
        monitorList
    );

    test("holds what was exported and the events", () => {
        const json = eventsToJSON(events, {
            exportedAt: new Date("2026-11-13T14:33:59.000Z"),
            from: new Date("2026-10-14T14:33:59.000Z"),
            hideGroupEvents: true,
        });

        assert.deepStrictEqual(JSON.parse(json), {
            exportedAt: "2026-11-13T14:33:59.000Z",
            from: "2026-10-14T14:33:59.000Z",
            hideGroupEvents: true,
            events: [
                {
                    time: "2026-11-13T07:26:42.000Z",
                    group: "Web cluster",
                    monitor: "web-1",
                    monitorID: 2,
                    status: "down",
                    message: 'failed, "quoted"\nsecond line',
                },
            ],
        });
    });

    test("has no start for everything", () => {
        const json = eventsToJSON([], { exportedAt: new Date(), from: null, hideGroupEvents: false });

        assert.strictEqual(JSON.parse(json).from, null);
        assert.deepStrictEqual(JSON.parse(json).events, []);
    });
});

describe("csvField()", () => {
    test("leaves a plain value alone", () => {
        assert.strictEqual(csvField("200 - OK"), "200 - OK");
        assert.strictEqual(csvField(""), "");
    });

    test("quotes commas, quotes and line breaks", () => {
        assert.strictEqual(csvField("a, b"), '"a, b"');
        assert.strictEqual(csvField('say "hi"'), '"say ""hi"""');
        assert.strictEqual(csvField("one\r\ntwo"), '"one\r\ntwo"');
    });

    test("keeps a spreadsheet from running a value as a formula", () => {
        assert.strictEqual(csvField("=1+1"), "'=1+1");
        assert.strictEqual(csvField("+1"), "'+1");
        assert.strictEqual(csvField("-1"), "'-1");
        assert.strictEqual(csvField("@SUM(A1)"), "'@SUM(A1)");
        assert.strictEqual(
            csvField('=HYPERLINK("http://example.com","x")'),
            '"\'=HYPERLINK(""http://example.com"",""x"")"'
        );
        // Only at the start
        assert.strictEqual(csvField("1 = 1"), "1 = 1");
    });
});

describe("eventsToCSV()", () => {
    const events: ExportedEvent[] = [
        {
            time: "2026-11-13T07:26:42.000Z",
            group: "Web cluster",
            monitor: "web-1",
            monitorID: 2,
            status: "down",
            message: 'failed, "quoted"',
        },
        {
            time: "2026-11-13T07:20:00.000Z",
            group: null,
            monitor: "Standalone API",
            monitorID: 3,
            status: "maintenance",
            message: "",
        },
    ];

    test("has the columns of the event list, one line per event", () => {
        const csv = eventsToCSV(events);

        assert.strictEqual(
            csv,
            "﻿Time (UTC),Group,Monitor,Status,Message\r\n" +
                '2026-11-13T07:26:42.000Z,Web cluster,web-1,Down,"failed, ""quoted"""\r\n' +
                "2026-11-13T07:20:00.000Z,,Standalone API,Maintenance,\r\n"
        );
    });

    test("shows the times the way it is told to", () => {
        const csv = eventsToCSV(events, (time) => time.slice(11, 19), "America/Chicago");
        const lines = csv.split("\r\n");

        assert.strictEqual(lines[0], "﻿Time (America/Chicago),Group,Monitor,Status,Message");
        assert.ok(lines[1].startsWith("07:26:42,"));
    });

    test("is only the header without events", () => {
        assert.strictEqual(eventsToCSV([]), "﻿Time (UTC),Group,Monitor,Status,Message\r\n");
    });
});

describe("eventExportFileName()", () => {
    test("has the time of the export and the format", () => {
        const now = new Date(2026, 10, 13, 7, 26, 42);

        assert.strictEqual(eventExportFileName("json", now), "uptime-kuma-events-20261113-072642.json");
        assert.strictEqual(eventExportFileName("csv", now), "uptime-kuma-events-20261113-072642.csv");
    });
});
