import fs from "node:fs";
import { expect, test } from "../fixtures";
import { login, restoreSqliteSnapshot, screenshot } from "../util-test";

const groupName = "Export Group";
const groupedName = "Grouped Push";
const plainName = "Plain Push";
const quotedMessage = 'boom, "quoted"';

/**
 * Create a group monitor through the add form
 * @param {import("@playwright/test").Page} page Page
 * @param {string} name Group name
 * @returns {Promise<void>}
 */
async function createGroup(page, name) {
    await page.goto("./add");
    await page.getByTestId("monitor-type-select").selectOption("group");
    await page.getByTestId("friendly-name-input").fill(name);
    await page.getByTestId("save-button").click();
    await page.waitForURL("/dashboard/*");
}

/**
 * Create a push monitor through the add form
 * @param {import("@playwright/test").Page} page Page
 * @param {string} name Monitor name
 * @param {string|null} group Name of the group to put it in
 * @returns {Promise<string>} Push endpoint path
 */
async function createPushMonitor(page, name, group = null) {
    await page.goto("./add");
    await page.getByTestId("monitor-type-select").selectOption("push");
    await page.getByTestId("friendly-name-input").fill(name);
    if (group) {
        await page.locator("#monitorGroupSelector").selectOption({ label: group });
    }
    await page.getByTestId("save-button").click();
    await page.waitForURL("/dashboard/*");

    const href = await page.locator('a[href*="/api/push/"]').first().getAttribute("href");
    return new URL(href, page.url()).pathname;
}

/**
 * Create a group with a monitor in it and a monitor outside of it, each with events, and open the dashboard
 * @param {import("@playwright/test").Page} page Page
 * @returns {Promise<void>}
 */
async function createEvents(page) {
    await page.goto("./add");
    await login(page);
    // The add form only shows once the login went through
    await expect(page.getByTestId("monitor-type-select")).toBeVisible();

    await createGroup(page, groupName);
    const groupedPush = await createPushMonitor(page, groupedName, groupName);
    const plainPush = await createPushMonitor(page, plainName);

    await page.request.get(`${groupedPush}?status=up&msg=OK&ping=5`);
    await page.request.get(`${groupedPush}?status=down&msg=${encodeURIComponent(quotedMessage)}&ping=`);
    await page.request.get(`${plainPush}?status=up&msg=${encodeURIComponent("=1+1")}&ping=5`);

    await page.goto("./dashboard");
    const eventList = page.locator("table tbody");
    await expect(eventList).toContainText(quotedMessage);
    await expect(eventList).toContainText("=1+1");
    // The group reported an event of its own when it started
    await expect(groupEvents(page)).not.toHaveCount(0);
}

/**
 * The rows of the event list with the events of the group itself
 * @param {import("@playwright/test").Page} page Page
 * @returns {import("@playwright/test").Locator} Rows
 */
function groupEvents(page) {
    return page.locator("table tbody tr").filter({ has: page.locator("td.name-column", { hasText: groupName }) });
}

/**
 * Export the events with the dialog as it is and read the file
 * @param {import("@playwright/test").Page} page Page
 * @returns {Promise<{ name: string, content: string }>} Name and content of the downloaded file
 */
async function exportEvents(page) {
    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("event-export-confirm").click();
    const download = await downloadPromise;

    return {
        name: download.suggestedFilename(),
        content: fs.readFileSync(await download.path(), "utf-8"),
    };
}

test.describe("Event export", () => {
    test.beforeEach(async ({ page }) => {
        await restoreSqliteSnapshot(page);
    });

    test("exports the event list as JSON", async ({ page }, testInfo) => {
        await createEvents(page);

        await page.getByTestId("export-events-button").click();
        await expect(page.getByTestId("event-export-format")).toHaveValue("json");
        await expect(page.getByTestId("event-export-period")).toHaveValue("720");
        await expect(page.getByTestId("event-export-group-note")).toHaveCount(0);
        await screenshot(testInfo, page);

        const before = Date.now();
        const file = await exportEvents(page);

        expect(file.name).toMatch(/^uptime-kuma-events-\d{8}-\d{6}\.json$/);
        const data = JSON.parse(file.content);

        expect(data.hideGroupEvents).toBe(false);
        expect(Date.parse(data.exportedAt)).toBeGreaterThanOrEqual(before - 1000);
        expect(Date.parse(data.exportedAt) - Date.parse(data.from)).toBe(720 * 3600 * 1000);

        // Newest first, like the event list
        const times = data.events.map((event) => Date.parse(event.time));
        expect(times).toEqual([...times].sort((a, b) => b - a));
        for (const event of data.events) {
            expect(event.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        }

        const grouped = data.events.filter((event) => event.monitor === groupedName);
        expect(grouped.map((event) => [event.group, event.status, event.message])).toEqual([
            [groupName, "down", quotedMessage],
            [groupName, "up", "OK"],
        ]);
        expect(typeof grouped[0].monitorID).toBe("number");

        const plain = data.events.filter((event) => event.monitor === plainName);
        expect(plain.map((event) => [event.group, event.status, event.message])).toEqual([[null, "up", "=1+1"]]);

        // The group reports events of its own, and they are in the export as long as the list shows them
        expect(data.events.some((event) => event.monitor === groupName)).toBe(true);

        // The dialog closes, and says how much it exported
        await expect(page.getByTestId("event-export-confirm")).toBeHidden();
        await expect(page.getByText(`Exported ${data.events.length} events`)).toBeVisible();
    });

    test.describe("in another timezone", () => {
        test.use({ timezoneId: "Asia/Tokyo" });

        test("exports the event list as CSV, and remembers the choice", async ({ page }) => {
            await createEvents(page);

            await page.getByTestId("export-events-button").click();
            const json = JSON.parse((await exportEvents(page)).content);
            await expect(page.getByTestId("event-export-confirm")).toBeHidden();

            await page.getByTestId("export-events-button").click();
            await page.getByTestId("event-export-format").selectOption("csv");
            await page.getByTestId("event-export-period").selectOption("0");
            const file = await exportEvents(page);

            expect(file.name).toMatch(/^uptime-kuma-events-\d{8}-\d{6}\.csv$/);
            const lines = file.content.split("\r\n");
            expect(lines[0]).toBe("﻿Time (Asia/Tokyo),Group,Monitor,Status,Message");
            // One line per event, and the file ends with a line break
            expect(lines.length).toBe(json.events.length + 2);
            expect(lines[lines.length - 1]).toBe("");

            // The times of the event list: Tokyo is nine hours ahead of UTC all year
            const localTime = (time) =>
                new Date(Date.parse(time) + 9 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");
            const down = json.events.find((event) => event.message === quotedMessage);
            expect(lines).toContain(`${localTime(down.time)},${groupName},${groupedName},Down,"boom, ""quoted"""`);

            // A spreadsheet must not run a message as a formula
            const formula = json.events.find((event) => event.message === "=1+1");
            expect(lines).toContain(`${localTime(formula.time)},,${plainName},Up,'=1+1`);

            // The dialog opens with the last export's choices, also after a reload
            await page.reload();
            await page.getByTestId("export-events-button").click();
            await expect(page.getByTestId("event-export-format")).toHaveValue("csv");
            await expect(page.getByTestId("event-export-period")).toHaveValue("0");
        });
    });

    test("leaves out the group events while the list hides them", async ({ page }, testInfo) => {
        await createEvents(page);

        // The switch comes from the toggle-child-events branch, this spec also runs without it
        const hideSwitch = page.locator("#hide-group-events");
        test.skip((await hideSwitch.count()) === 0, "This build has no Hide group events switch");

        await hideSwitch.check();
        await expect(groupEvents(page)).toHaveCount(0);

        await page.getByTestId("export-events-button").click();
        await expect(page.getByTestId("event-export-group-note")).toBeVisible();
        await screenshot(testInfo, page);

        const data = JSON.parse((await exportEvents(page)).content);

        expect(data.hideGroupEvents).toBe(true);
        expect(data.events.some((event) => event.monitor === groupName)).toBe(false);
        // The events of the monitor in the group stay
        expect(data.events.filter((event) => event.group === groupName).length).toBe(2);
    });

    test("says so when there is nothing to export", async ({ page }) => {
        await page.goto("./dashboard");
        await login(page);

        await page.getByTestId("export-events-button").click();
        let downloads = 0;
        page.on("download", () => downloads++);
        await page.getByTestId("event-export-confirm").click();

        await expect(page.getByText("There are no events in this period.")).toBeVisible();
        // The dialog stays, to pick a longer period
        await expect(page.getByTestId("event-export-confirm")).toBeVisible();
        expect(downloads).toBe(0);
    });
});
