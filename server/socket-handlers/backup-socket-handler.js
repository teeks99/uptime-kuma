const { R } = require("redbean-node");
const { checkLogin } = require("../util-server");
const { log } = require("../../src/util");
const { UptimeKumaServer } = require("../uptime-kuma-server");
const server = UptimeKumaServer.getInstance();

/**
 * Handlers for backup and restore
 * @param {Socket} socket Socket.io instance
 * @returns {void}
 */
module.exports.backupSocketHandler = (socket) => {
    socket.on("backupData", async (callback) => {
        try {
            checkLogin(socket);

            const userID = socket.userID;
            if (!userID) {
                throw new Error("User ID is not defined");
            }

            const monitors = await R.findAll("monitor", " AND user_id = ? ", [userID]);
            const proxies = await R.findAll("proxy", " AND user_id = ? ", [userID]);
            const docker_hosts = await R.findAll("docker_host", " AND user_id = ? ", [userID]);
            const maintenances = await R.findAll("maintenance", " AND user_id = ? ", [userID]);
            const notifications = await R.findAll("notification", " AND user_id = ? ", [userID]);

            const monitorIds = monitors.map((m) => m.id);
            let monitorTags = [];
            let monitorGroups = [];
            let monitorNotifications = [];
            let monitorMaintenances = [];
            let tags = [];
            let groups = [];
            let maintenanceTimeslots = [];

            if (monitorIds.length > 0) {
                const placeholders = monitorIds.map(() => "?").join(",");
                monitorTags = await R.findAll("monitor_tag", ` AND monitor_id IN (${placeholders}) `, monitorIds);
                monitorGroups = await R.findAll("monitor_group", ` AND monitor_id IN (${placeholders}) `, monitorIds);
                monitorNotifications = await R.findAll(
                    "monitor_notification",
                    ` AND monitor_id IN (${placeholders}) `,
                    monitorIds
                );

                const tagIds = [...new Set(monitorTags.map((mt) => mt.tag_id))];
                if (tagIds.length > 0) {
                    const tagPlaceholders = tagIds.map(() => "?").join(",");
                    tags = await R.findAll("tag", ` AND id IN (${tagPlaceholders}) `, tagIds);
                }

                const groupIds = [...new Set(monitorGroups.map((mg) => mg.group_id))];
                if (groupIds.length > 0) {
                    const groupPlaceholders = groupIds.map(() => "?").join(",");
                    groups = await R.findAll("group", ` AND id IN (${groupPlaceholders}) `, groupIds);
                }
            }

            const maintenanceIds = maintenances.map((m) => m.id);
            if (maintenanceIds.length > 0) {
                const placeholders = maintenanceIds.map(() => "?").join(",");
                maintenanceTimeslots = await R.findAll(
                    "maintenance_timeslot",
                    ` AND maintenance_id IN (${placeholders}) `,
                    maintenanceIds
                );
                monitorMaintenances = await R.findAll(
                    "monitor_maintenance",
                    ` AND maintenance_id IN (${placeholders}) `,
                    maintenanceIds
                );
            }

            const backupData = {
                version: "1.0",
                data: {
                    monitor: monitors.map((b) => b.export()),
                    proxy: proxies.map((b) => b.export()),
                    docker_host: docker_hosts.map((b) => b.export()),
                    maintenance: maintenances.map((b) => b.export()),
                    notification: notifications.map((b) => b.export()),
                    monitor_tag: monitorTags.map((b) => b.export()),
                    monitor_group: monitorGroups.map((b) => b.export()),
                    monitor_notification: monitorNotifications.map((b) => b.export()),
                    monitor_maintenance: monitorMaintenances.map((b) => b.export()),
                    tag: tags.map((b) => b.export()),
                    group: groups.map((b) => b.export()),
                    maintenance_timeslot: maintenanceTimeslots.map((b) => b.export()),
                },
            };

            callback({
                ok: true,
                backup: backupData,
            });
        } catch (error) {
            callback({
                ok: false,
                msg: error.message,
            });
        }
    });

    socket.on("restoreData", async (backupData, callback) => {
        try {
            checkLogin(socket);

            const userID = socket.userID;
            if (!userID) {
                throw new Error("User ID is not defined");
            }

            if (!backupData || !backupData.data) {
                throw new Error("Invalid backup format");
            }

            const { data } = backupData;
            const idMap = {
                proxy: {},
                docker_host: {},
                notification: {},
                tag: {},
                group: {},
                maintenance: {},
                monitor: {},
            };

            await R.knex.transaction(async (trx) => {
                // Restore logic: map old ID to new ID as we insert

                // 1. Global Entities
                // tags
                if (data.tag) {
                    const columns = await trx("tag").columnInfo();
                    const allowedKeys = Object.keys(columns);
                    for (const oldTag of data.tag) {
                        const existingTag = await trx("tag").where("name", oldTag.name).first();
                        if (existingTag) {
                            idMap.tag[oldTag.id] = existingTag.id;
                        } else {
                            const tagData = {};
                            for (const k of Object.keys(oldTag)) {
                                if (allowedKeys.includes(k) && k !== "id") {
                                    tagData[k] = oldTag[k];
                                }
                            }
                            const [newId] = await trx("tag").insert(tagData);
                            idMap.tag[oldTag.id] = newId;
                        }
                    }
                }

                // groups
                if (data.group) {
                    const columns = await trx("group").columnInfo();
                    const allowedKeys = Object.keys(columns);
                    for (const oldGroup of data.group) {
                        const existingGroup = await trx("group").where("name", oldGroup.name).first();
                        if (existingGroup) {
                            idMap.group[oldGroup.id] = existingGroup.id;
                        } else {
                            const groupData = {};
                            for (const k of Object.keys(oldGroup)) {
                                if (allowedKeys.includes(k) && k !== "id") {
                                    groupData[k] = oldGroup[k];
                                }
                            }
                            const [newId] = await trx("group").insert(groupData);
                            idMap.group[oldGroup.id] = newId;
                        }
                    }
                }

                // 2. User-Scoped Independent Entities
                const userScopedInsert = async (table, items) => {
                    if (!items) {
                        return;
                    }
                    const columns = await trx(table).columnInfo();
                    const allowedKeys = Object.keys(columns);
                    for (const item of items) {
                        const oldId = item.id;
                        const itemData = {};
                        for (const k of Object.keys(item)) {
                            if (allowedKeys.includes(k) && k !== "id") {
                                itemData[k] = item[k];
                            }
                        }
                        itemData.user_id = userID;
                        const [newId] = await trx(table).insert(itemData);
                        idMap[table][oldId] = newId;
                    }
                };

                await userScopedInsert("proxy", data.proxy);
                await userScopedInsert("docker_host", data.docker_host);
                await userScopedInsert("notification", data.notification);
                await userScopedInsert("maintenance", data.maintenance);

                // 3. Maintenance Timeslots
                if (data.maintenance_timeslot) {
                    const columns = await trx("maintenance_timeslot").columnInfo();
                    const allowedKeys = Object.keys(columns);
                    for (const item of data.maintenance_timeslot) {
                        const newMaintenanceId = idMap.maintenance[item.maintenance_id];
                        if (newMaintenanceId) {
                            const itemData = {};
                            for (const k of Object.keys(item)) {
                                if (allowedKeys.includes(k) && k !== "id") {
                                    itemData[k] = item[k];
                                }
                            }
                            itemData.maintenance_id = newMaintenanceId;
                            await trx("maintenance_timeslot").insert(itemData);
                        }
                    }
                }

                // 4. Monitors
                if (data.monitor) {
                    const columns = await trx("monitor").columnInfo();
                    const allowedKeys = Object.keys(columns);
                    for (const item of data.monitor) {
                        const oldId = item.id;
                        const itemData = {};
                        for (const k of Object.keys(item)) {
                            if (allowedKeys.includes(k) && k !== "id") {
                                itemData[k] = item[k];
                            }
                        }
                        itemData.user_id = userID;

                        if (itemData.proxy_id) {
                            itemData.proxy_id = idMap.proxy[itemData.proxy_id] || null;
                        }
                        if (itemData.docker_host) {
                            itemData.docker_host = idMap.docker_host[itemData.docker_host] || null;
                        }

                        // We delay parent ID mapping since the parent monitor might not be inserted yet

                        const [newId] = await trx("monitor").insert(itemData);
                        idMap.monitor[oldId] = newId;
                    }

                    // Update parent references
                    for (const item of data.monitor) {
                        if (item.parent) {
                            const newId = idMap.monitor[item.id];
                            const newParentId = idMap.monitor[item.parent];
                            if (newId && newParentId) {
                                await trx("monitor").where("id", newId).update({ parent: newParentId });
                            }
                        }
                    }
                }

                // 5. Monitor Relations
                const relationInsert = async (table, items, foreignKey1, foreignKey2, map1, map2) => {
                    if (!items) {
                        return;
                    }
                    const columns = await trx(table).columnInfo();
                    const allowedKeys = Object.keys(columns);
                    for (const item of items) {
                        const newFk1 = map1[item[foreignKey1]];
                        const newFk2 = map2[item[foreignKey2]];
                        if (newFk1 && newFk2) {
                            const itemData = {};
                            for (const k of Object.keys(item)) {
                                if (allowedKeys.includes(k) && k !== "id") {
                                    itemData[k] = item[k];
                                }
                            }
                            itemData[foreignKey1] = newFk1;
                            itemData[foreignKey2] = newFk2;
                            await trx(table).insert(itemData);
                        }
                    }
                };

                await relationInsert("monitor_tag", data.monitor_tag, "monitor_id", "tag_id", idMap.monitor, idMap.tag);
                await relationInsert(
                    "monitor_group",
                    data.monitor_group,
                    "monitor_id",
                    "group_id",
                    idMap.monitor,
                    idMap.group
                );
                await relationInsert(
                    "monitor_notification",
                    data.monitor_notification,
                    "monitor_id",
                    "notification_id",
                    idMap.monitor,
                    idMap.notification
                );
                await relationInsert(
                    "monitor_maintenance",
                    data.monitor_maintenance,
                    "monitor_id",
                    "maintenance_id",
                    idMap.monitor,
                    idMap.maintenance
                );
            });

            // Need to broadcast to the UI to update lists and restart monitors
            const client = require("../client");
            server.sendMonitorList(socket);
            client.sendProxyList(socket);
            client.sendDockerHostList(socket);
            client.sendNotificationList(socket);
            server.sendMaintenanceList(socket);

            // start the new monitors
            if (data.monitor) {
                const s = require("../uptime-kuma-server").UptimeKumaServer.getInstance();
                const io = s.io;
                for (const oldMonitor of data.monitor) {
                    const newId = idMap.monitor[oldMonitor.id];
                    if (newId) {
                        let monitor = await R.findOne("monitor", " id = ? ", [newId]);
                        if (monitor.active) {
                            s.monitorList[monitor.id] = monitor;
                            await monitor.start(io);
                        }
                    }
                }
            }

            callback({
                ok: true,
                msg: "Import completed successfully.",
            });
        } catch (error) {
            log.error("backup", error);
            callback({
                ok: false,
                msg: error.message,
            });
        }
    });
};
