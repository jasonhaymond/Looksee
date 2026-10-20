// A built-in dictionary of common SNMP OIDs — what a number like
// 1.3.6.1.2.1.2.2.1.8.3 means ("IF-MIB::ifOperStatus, interface 3"), what
// its values mean ("1" = up), and its unit — so the walk browser can show
// names and readable values without loading vendor MIB files.
//
// Where this sits: routes/checks.ts adds names and readable values to every
// SNMP walk (annotateWalk) and answers "find an OID by name" searches
// (searchOids). No database access, so the site collector can use it too.
//
// Coverage: the standard MIB-2 groups (system, interfaces, IP, TCP, UDP,
// ICMP), HOST-RESOURCES, ENTITY and ENTITY-SENSOR, UPS-MIB, Printer-MIB,
// BRIDGE and LLDP, Net-SNMP's UCD-SNMP-MIB (Linux, pfSense, OPNsense…), and
// popular vendor values: Synology, APC, Cisco and Dell iDRAC. OIDs not in
// the dictionary are still shown, just without a name.

import { own } from "../../lib/own.js";
/** One dictionary entry. A "table column" entry covers every row under it. */
export type MibEntry = {
  oid: string;
  name: string;
  mib: string;
  description: string;
  // How to show the value: a unit (with an optional scale — "0.1" means the
  // device reports tenths), named values, or a special kind.
  unit?: string;
  scale?: number;
  enum?: Record<number, string>;
  kind?: "timeticks" | "counter" | "bytes" | "kbytes" | "bps" | "text";
  // A table column: the OID suffix after it is the row (instance).
  column?: boolean;
};

const UP_DOWN = { 1: "up", 2: "down", 3: "testing", 4: "unknown", 5: "dormant", 6: "notPresent", 7: "lowerLayerDown" };
const CISCO_ENV = { 1: "normal", 2: "warning", 3: "critical", 4: "shutdown", 5: "notPresent", 6: "notFunctioning" };
const SYNO_OK = { 1: "normal", 2: "failed" };

// Builds table-column entries from a column number → [name, description, extra] map.
function table(base: string, mib: string, cols: Record<number, [string, string, Partial<MibEntry>?]>): MibEntry[] {
  return Object.entries(cols).map(([n, [name, description, extra]]) => ({ oid: `${base}.${n}`, name, mib, description, column: true, ...extra }));
}

export const MIBS: MibEntry[] = [
  // ---- SNMPv2-MIB: system ----
  { oid: "1.3.6.1.2.1.1.1", name: "sysDescr", mib: "SNMPv2-MIB", description: "Device description (model, OS, version)", kind: "text" },
  { oid: "1.3.6.1.2.1.1.2", name: "sysObjectID", mib: "SNMPv2-MIB", description: "Vendor and model identifier (an OID)" },
  { oid: "1.3.6.1.2.1.1.3", name: "sysUpTime", mib: "SNMPv2-MIB", description: "Time since the SNMP agent (usually the device) started", kind: "timeticks" },
  { oid: "1.3.6.1.2.1.1.4", name: "sysContact", mib: "SNMPv2-MIB", description: "Contact person", kind: "text" },
  { oid: "1.3.6.1.2.1.1.5", name: "sysName", mib: "SNMPv2-MIB", description: "Device name", kind: "text" },
  { oid: "1.3.6.1.2.1.1.6", name: "sysLocation", mib: "SNMPv2-MIB", description: "Physical location", kind: "text" },
  { oid: "1.3.6.1.2.1.1.7", name: "sysServices", mib: "SNMPv2-MIB", description: "Network layers the device serves (bit mask)" },

  // ---- IF-MIB: interfaces ----
  { oid: "1.3.6.1.2.1.2.1", name: "ifNumber", mib: "IF-MIB", description: "Number of network interfaces" },
  ...table("1.3.6.1.2.1.2.2.1", "IF-MIB", {
    1: ["ifIndex", "Interface number"],
    2: ["ifDescr", "Interface description", { kind: "text" }],
    3: ["ifType", "Interface type (6 = Ethernet, 24 = loopback, 53 = virtual, 131 = tunnel, 161 = LAG)"],
    4: ["ifMtu", "Largest packet size", { unit: " bytes" }],
    5: ["ifSpeed", "Link speed (max ~4.3 Gbps — use ifHighSpeed for faster links)", { kind: "bps" }],
    6: ["ifPhysAddress", "MAC address"],
    7: ["ifAdminStatus", "Administrative state (switched on or off by config)", { enum: { 1: "up", 2: "down", 3: "testing" } }],
    8: ["ifOperStatus", "Actual link state", { enum: UP_DOWN }],
    9: ["ifLastChange", "Uptime when the interface last changed state", { kind: "timeticks" }],
    10: ["ifInOctets", "Bytes received (32-bit counter — wraps fast on busy links; prefer ifHCInOctets)", { kind: "counter", unit: " bytes" }],
    11: ["ifInUcastPkts", "Unicast packets received", { kind: "counter" }],
    13: ["ifInDiscards", "Received packets dropped (e.g. buffers full)", { kind: "counter" }],
    14: ["ifInErrors", "Received packets with errors (bad cable, duplex mismatch)", { kind: "counter" }],
    15: ["ifInUnknownProtos", "Received packets of an unknown protocol", { kind: "counter" }],
    16: ["ifOutOctets", "Bytes sent (32-bit counter; prefer ifHCOutOctets)", { kind: "counter", unit: " bytes" }],
    17: ["ifOutUcastPkts", "Unicast packets sent", { kind: "counter" }],
    19: ["ifOutDiscards", "Outgoing packets dropped", { kind: "counter" }],
    20: ["ifOutErrors", "Outgoing packets with errors", { kind: "counter" }],
    21: ["ifOutQLen", "Output queue length"],
  }),
  ...table("1.3.6.1.2.1.31.1.1.1", "IF-MIB", {
    1: ["ifName", "Interface short name (Gi1/0/1, eth0)", { kind: "text" }],
    2: ["ifInMulticastPkts", "Multicast packets received", { kind: "counter" }],
    3: ["ifInBroadcastPkts", "Broadcast packets received", { kind: "counter" }],
    4: ["ifOutMulticastPkts", "Multicast packets sent", { kind: "counter" }],
    5: ["ifOutBroadcastPkts", "Broadcast packets sent", { kind: "counter" }],
    6: ["ifHCInOctets", "Bytes received (64-bit counter)", { kind: "counter", unit: " bytes" }],
    7: ["ifHCInUcastPkts", "Unicast packets received (64-bit)", { kind: "counter" }],
    10: ["ifHCOutOctets", "Bytes sent (64-bit counter)", { kind: "counter", unit: " bytes" }],
    11: ["ifHCOutUcastPkts", "Unicast packets sent (64-bit)", { kind: "counter" }],
    15: ["ifHighSpeed", "Link speed", { unit: " Mbps" }],
    16: ["ifPromiscuousMode", "Receiving all traffic", { enum: { 1: "true", 2: "false" } }],
    17: ["ifConnectorPresent", "Has a physical connector", { enum: { 1: "true", 2: "false" } }],
    18: ["ifAlias", "Interface description set by an admin", { kind: "text" }],
  }),

  // ---- IP / TCP / UDP / ICMP ----
  { oid: "1.3.6.1.2.1.4.1", name: "ipForwarding", mib: "IP-MIB", description: "Routing between interfaces", enum: { 1: "forwarding (router)", 2: "notForwarding (host)" } },
  ...table("1.3.6.1.2.1.4.20.1", "IP-MIB", { 1: ["ipAdEntAddr", "IPv4 address"], 2: ["ipAdEntIfIndex", "Interface the address is on"], 3: ["ipAdEntNetMask", "Subnet mask"] }),
  { oid: "1.3.6.1.2.1.5.1", name: "icmpInMsgs", mib: "IP-MIB", description: "ICMP messages received", kind: "counter" },
  { oid: "1.3.6.1.2.1.5.2", name: "icmpInErrors", mib: "IP-MIB", description: "ICMP messages received with errors", kind: "counter" },
  { oid: "1.3.6.1.2.1.5.14", name: "icmpOutMsgs", mib: "IP-MIB", description: "ICMP messages sent", kind: "counter" },
  { oid: "1.3.6.1.2.1.6.5", name: "tcpActiveOpens", mib: "TCP-MIB", description: "Outgoing TCP connections opened", kind: "counter" },
  { oid: "1.3.6.1.2.1.6.6", name: "tcpPassiveOpens", mib: "TCP-MIB", description: "Incoming TCP connections accepted", kind: "counter" },
  { oid: "1.3.6.1.2.1.6.7", name: "tcpAttemptFails", mib: "TCP-MIB", description: "Failed TCP connection attempts", kind: "counter" },
  { oid: "1.3.6.1.2.1.6.8", name: "tcpEstabResets", mib: "TCP-MIB", description: "Established connections reset", kind: "counter" },
  { oid: "1.3.6.1.2.1.6.9", name: "tcpCurrEstab", mib: "TCP-MIB", description: "TCP connections open right now" },
  { oid: "1.3.6.1.2.1.6.10", name: "tcpInSegs", mib: "TCP-MIB", description: "TCP segments received", kind: "counter" },
  { oid: "1.3.6.1.2.1.6.11", name: "tcpOutSegs", mib: "TCP-MIB", description: "TCP segments sent", kind: "counter" },
  { oid: "1.3.6.1.2.1.6.12", name: "tcpRetransSegs", mib: "TCP-MIB", description: "TCP segments resent (high = packet loss)", kind: "counter" },
  { oid: "1.3.6.1.2.1.6.14", name: "tcpInErrs", mib: "TCP-MIB", description: "TCP segments received with errors", kind: "counter" },
  { oid: "1.3.6.1.2.1.7.1", name: "udpInDatagrams", mib: "UDP-MIB", description: "UDP datagrams received", kind: "counter" },
  { oid: "1.3.6.1.2.1.7.2", name: "udpNoPorts", mib: "UDP-MIB", description: "UDP datagrams to a port nothing listens on", kind: "counter" },
  { oid: "1.3.6.1.2.1.7.3", name: "udpInErrors", mib: "UDP-MIB", description: "UDP datagrams dropped (errors, buffers full)", kind: "counter" },
  { oid: "1.3.6.1.2.1.7.4", name: "udpOutDatagrams", mib: "UDP-MIB", description: "UDP datagrams sent", kind: "counter" },

  // ---- HOST-RESOURCES-MIB ----
  { oid: "1.3.6.1.2.1.25.1.1", name: "hrSystemUptime", mib: "HOST-RESOURCES-MIB", description: "Time since the host (not just the agent) started", kind: "timeticks" },
  { oid: "1.3.6.1.2.1.25.1.5", name: "hrSystemNumUsers", mib: "HOST-RESOURCES-MIB", description: "Logged-in users" },
  { oid: "1.3.6.1.2.1.25.1.6", name: "hrSystemProcesses", mib: "HOST-RESOURCES-MIB", description: "Running processes" },
  { oid: "1.3.6.1.2.1.25.1.7", name: "hrSystemMaxProcesses", mib: "HOST-RESOURCES-MIB", description: "Process limit (0 = none)" },
  { oid: "1.3.6.1.2.1.25.2.2", name: "hrMemorySize", mib: "HOST-RESOURCES-MIB", description: "Installed memory", kind: "kbytes" },
  ...table("1.3.6.1.2.1.25.2.3.1", "HOST-RESOURCES-MIB", {
    1: ["hrStorageIndex", "Storage area number"],
    2: ["hrStorageType", "Kind of storage (RAM, virtual memory, fixed disk…) as an OID"],
    3: ["hrStorageDescr", "Storage area name (/, C:\\ Label, Physical memory)", { kind: "text" }],
    4: ["hrStorageAllocationUnits", "Size of one unit (multiply Size/Used by this for bytes)", { unit: " bytes" }],
    5: ["hrStorageSize", "Total size, in allocation units"],
    6: ["hrStorageUsed", "Used, in allocation units"],
    7: ["hrStorageAllocationFailures", "Times space couldn't be allocated", { kind: "counter" }],
  }),
  ...table("1.3.6.1.2.1.25.3.2.1", "HOST-RESOURCES-MIB", {
    2: ["hrDeviceType", "Device type (an OID)"],
    3: ["hrDeviceDescr", "Device description", { kind: "text" }],
    5: ["hrDeviceStatus", "Device state", { enum: { 1: "unknown", 2: "running", 3: "warning", 4: "testing", 5: "down" } }],
    6: ["hrDeviceErrors", "Errors on the device", { kind: "counter" }],
  }),
  ...table("1.3.6.1.2.1.25.3.3.1", "HOST-RESOURCES-MIB", { 2: ["hrProcessorLoad", "CPU load over the last minute, per core", { unit: "%" }] }),
  ...table("1.3.6.1.2.1.25.3.5.1", "HOST-RESOURCES-MIB", {
    1: ["hrPrinterStatus", "Printer state", { enum: { 1: "other", 2: "unknown", 3: "idle", 4: "printing", 5: "warmup" } }],
    2: ["hrPrinterDetectedErrorState", "Printer problems as bit flags (paper out, jam, toner low…; 00 = none)"],
  }),
  ...table("1.3.6.1.2.1.25.4.2.1", "HOST-RESOURCES-MIB", {
    2: ["hrSWRunName", "Process name", { kind: "text" }],
    4: ["hrSWRunPath", "Process path", { kind: "text" }],
    5: ["hrSWRunParameters", "Process arguments", { kind: "text" }],
    7: ["hrSWRunStatus", "Process state", { enum: { 1: "running", 2: "runnable", 3: "notRunnable", 4: "invalid" } }],
  }),
  ...table("1.3.6.1.2.1.25.5.1.1", "HOST-RESOURCES-MIB", { 1: ["hrSWRunPerfCPU", "CPU time used by the process (centiseconds)", { kind: "counter" }], 2: ["hrSWRunPerfMem", "Memory used by the process", { kind: "kbytes" }] }),
  ...table("1.3.6.1.2.1.25.6.3.1", "HOST-RESOURCES-MIB", { 2: ["hrSWInstalledName", "Installed software", { kind: "text" }] }),

  // ---- ENTITY-MIB / ENTITY-SENSOR-MIB ----
  ...table("1.3.6.1.2.1.47.1.1.1.1", "ENTITY-MIB", {
    2: ["entPhysicalDescr", "Hardware component description", { kind: "text" }],
    5: ["entPhysicalClass", "Component kind", { enum: { 1: "other", 2: "unknown", 3: "chassis", 4: "backplane", 5: "container", 6: "powerSupply", 7: "fan", 8: "sensor", 9: "module", 10: "port", 11: "stack", 12: "cpu" } }],
    7: ["entPhysicalName", "Component name", { kind: "text" }],
    8: ["entPhysicalHardwareRev", "Hardware revision", { kind: "text" }],
    9: ["entPhysicalFirmwareRev", "Firmware version", { kind: "text" }],
    10: ["entPhysicalSoftwareRev", "Software version", { kind: "text" }],
    11: ["entPhysicalSerialNum", "Serial number", { kind: "text" }],
    12: ["entPhysicalMfgName", "Manufacturer", { kind: "text" }],
    13: ["entPhysicalModelName", "Model", { kind: "text" }],
  }),
  ...table("1.3.6.1.2.1.99.1.1.1", "ENTITY-SENSOR-MIB", {
    1: ["entPhySensorType", "What the sensor measures", { enum: { 1: "other", 2: "unknown", 3: "voltsAC", 4: "voltsDC", 5: "amperes", 6: "watts", 7: "hertz", 8: "celsius", 9: "percentRH", 10: "rpm", 11: "cmm", 12: "truthvalue" } }],
    2: ["entPhySensorScale", "Power of ten for the value (9 = units, 8 = milli…)"],
    3: ["entPhySensorPrecision", "Decimal places in the value"],
    4: ["entPhySensorValue", "Sensor reading (see its type, scale and precision)"],
    5: ["entPhySensorOperStatus", "Sensor state", { enum: { 1: "ok", 2: "unavailable", 3: "nonoperational" } }],
    6: ["entPhySensorUnitsDisplay", "Unit as text", { kind: "text" }],
  }),

  // ---- UPS-MIB (RFC 1628) ----
  { oid: "1.3.6.1.2.1.33.1.1.1", name: "upsIdentManufacturer", mib: "UPS-MIB", description: "UPS maker", kind: "text" },
  { oid: "1.3.6.1.2.1.33.1.1.2", name: "upsIdentModel", mib: "UPS-MIB", description: "UPS model", kind: "text" },
  { oid: "1.3.6.1.2.1.33.1.2.1", name: "upsBatteryStatus", mib: "UPS-MIB", description: "Battery state", enum: { 1: "unknown", 2: "batteryNormal", 3: "batteryLow", 4: "batteryDepleted" } },
  { oid: "1.3.6.1.2.1.33.1.2.2", name: "upsSecondsOnBattery", mib: "UPS-MIB", description: "Time on battery (0 = on mains)", unit: " s" },
  { oid: "1.3.6.1.2.1.33.1.2.3", name: "upsEstimatedMinutesRemaining", mib: "UPS-MIB", description: "Estimated runtime left", unit: " min" },
  { oid: "1.3.6.1.2.1.33.1.2.4", name: "upsEstimatedChargeRemaining", mib: "UPS-MIB", description: "Battery charge", unit: "%" },
  { oid: "1.3.6.1.2.1.33.1.2.5", name: "upsBatteryVoltage", mib: "UPS-MIB", description: "Battery voltage", unit: " V", scale: 0.1 },
  { oid: "1.3.6.1.2.1.33.1.2.7", name: "upsBatteryTemperature", mib: "UPS-MIB", description: "Battery temperature", unit: "°C" },
  { oid: "1.3.6.1.2.1.33.1.3.1", name: "upsInputLineBads", mib: "UPS-MIB", description: "Times mains power went out of range", kind: "counter" },
  { oid: "1.3.6.1.2.1.33.1.3.3.1.3", name: "upsInputVoltage", mib: "UPS-MIB", description: "Input voltage per phase", unit: " V", column: true },
  { oid: "1.3.6.1.2.1.33.1.4.1", name: "upsOutputSource", mib: "UPS-MIB", description: "Where output power comes from", enum: { 1: "other", 2: "none", 3: "normal", 4: "bypass", 5: "battery", 6: "booster", 7: "reducer" } },
  { oid: "1.3.6.1.2.1.33.1.4.4.1.2", name: "upsOutputVoltage", mib: "UPS-MIB", description: "Output voltage per phase", unit: " V", column: true },
  { oid: "1.3.6.1.2.1.33.1.4.4.1.5", name: "upsOutputPercentLoad", mib: "UPS-MIB", description: "Load per phase", unit: "%", column: true },
  { oid: "1.3.6.1.2.1.33.1.6.1", name: "upsAlarmsPresent", mib: "UPS-MIB", description: "Active alarms" },

  // ---- Printer-MIB ----
  ...table("1.3.6.1.2.1.43.11.1.1", "Printer-MIB", {
    6: ["prtMarkerSuppliesDescription", "Supply name (toner, drum, waste box)", { kind: "text" }],
    8: ["prtMarkerSuppliesMaxCapacity", "Supply full capacity"],
    9: ["prtMarkerSuppliesLevel", "Supply level (-3 = some left, -2 = unknown; divide by max capacity for %)"],
  }),
  { oid: "1.3.6.1.2.1.43.10.2.1.4", name: "prtMarkerLifeCount", mib: "Printer-MIB", description: "Total pages printed", column: true, kind: "counter" },
  ...table("1.3.6.1.2.1.43.8.2.1", "Printer-MIB", { 9: ["prtInputMaxCapacity", "Paper tray capacity"], 10: ["prtInputCurrentLevel", "Paper in tray (-3 = some, -2 = unknown, 0 = empty)"], 13: ["prtInputDescription", "Tray name", { kind: "text" }] }),
  ...table("1.3.6.1.2.1.43.18.1.1", "Printer-MIB", { 2: ["prtAlertSeverityLevel", "Alert severity", { enum: { 1: "other", 3: "critical", 4: "warning", 5: "warningBinaryChangeEvent" } }], 8: ["prtAlertDescription", "Alert text", { kind: "text" }] }),
  { oid: "1.3.6.1.2.1.43.16.5.1.2", name: "prtConsoleDisplayBufferText", mib: "Printer-MIB", description: "Text on the printer's display", kind: "text", column: true },

  // ---- BRIDGE-MIB / LLDP-MIB ----
  { oid: "1.3.6.1.2.1.17.1.2", name: "dot1dBaseNumPorts", mib: "BRIDGE-MIB", description: "Switch ports" },
  { oid: "1.3.6.1.2.1.17.2.3", name: "dot1dStpTimeSinceTopologyChange", mib: "BRIDGE-MIB", description: "Time since spanning tree last changed", kind: "timeticks" },
  { oid: "1.3.6.1.2.1.17.2.4", name: "dot1dStpTopChanges", mib: "BRIDGE-MIB", description: "Spanning-tree topology changes (a rising count = a loop or flapping link)", kind: "counter" },
  { oid: "1.3.6.1.2.1.17.4.3.1.2", name: "dot1dTpFdbPort", mib: "BRIDGE-MIB", description: "Port a MAC address was learned on", column: true },
  ...table("1.0.8802.1.1.2.1.4.1.1", "LLDP-MIB", { 5: ["lldpRemChassisId", "Neighbour's chassis ID"], 7: ["lldpRemPortId", "Neighbour's port ID"], 8: ["lldpRemPortDesc", "Neighbour's port description", { kind: "text" }], 9: ["lldpRemSysName", "Neighbour's name", { kind: "text" }] }),

  // ---- UCD-SNMP-MIB (Net-SNMP: Linux, pfSense, OPNsense, many appliances) ----
  ...table("1.3.6.1.4.1.2021.2.1", "UCD-SNMP-MIB", { 2: ["prNames", "Watched process name", { kind: "text" }], 5: ["prCount", "Copies running"], 100: ["prErrorFlag", "Process problem", { enum: { 0: "ok", 1: "error" } }] }),
  { oid: "1.3.6.1.4.1.2021.4.3", name: "memTotalSwap", mib: "UCD-SNMP-MIB", description: "Swap size", kind: "kbytes" },
  { oid: "1.3.6.1.4.1.2021.4.4", name: "memAvailSwap", mib: "UCD-SNMP-MIB", description: "Swap free", kind: "kbytes" },
  { oid: "1.3.6.1.4.1.2021.4.5", name: "memTotalReal", mib: "UCD-SNMP-MIB", description: "Memory installed", kind: "kbytes" },
  { oid: "1.3.6.1.4.1.2021.4.6", name: "memAvailReal", mib: "UCD-SNMP-MIB", description: "Memory free (not counting cache)", kind: "kbytes" },
  { oid: "1.3.6.1.4.1.2021.4.11", name: "memTotalFree", mib: "UCD-SNMP-MIB", description: "Memory + swap free", kind: "kbytes" },
  { oid: "1.3.6.1.4.1.2021.4.14", name: "memBuffer", mib: "UCD-SNMP-MIB", description: "Memory used for buffers", kind: "kbytes" },
  { oid: "1.3.6.1.4.1.2021.4.15", name: "memCached", mib: "UCD-SNMP-MIB", description: "Memory used for cache (reclaimable)", kind: "kbytes" },
  ...table("1.3.6.1.4.1.2021.9.1", "UCD-SNMP-MIB", {
    2: ["dskPath", "Watched disk mount point", { kind: "text" }],
    3: ["dskDevice", "Watched disk device", { kind: "text" }],
    6: ["dskTotal", "Disk size", { kind: "kbytes" }],
    7: ["dskAvail", "Disk free", { kind: "kbytes" }],
    8: ["dskUsed", "Disk used", { kind: "kbytes" }],
    9: ["dskPercent", "Disk used", { unit: "%" }],
    100: ["dskErrorFlag", "Below the configured minimum free", { enum: { 0: "ok", 1: "error" } }],
  }),
  ...table("1.3.6.1.4.1.2021.10.1", "UCD-SNMP-MIB", { 2: ["laNames", "Load average period", { kind: "text" }], 3: ["laLoad", "Load average (as text)", { kind: "text" }], 5: ["laLoadInt", "Load average × 100", { scale: 0.01 }] }),
  { oid: "1.3.6.1.4.1.2021.11.9", name: "ssCpuUser", mib: "UCD-SNMP-MIB", description: "CPU time in user programs", unit: "%" },
  { oid: "1.3.6.1.4.1.2021.11.10", name: "ssCpuSystem", mib: "UCD-SNMP-MIB", description: "CPU time in the kernel", unit: "%" },
  { oid: "1.3.6.1.4.1.2021.11.11", name: "ssCpuIdle", mib: "UCD-SNMP-MIB", description: "CPU idle (100 minus this = busy)", unit: "%" },

  // ---- Synology DSM ----
  { oid: "1.3.6.1.4.1.6574.1.1", name: "systemStatus", mib: "SYNOLOGY-SYSTEM-MIB", description: "Overall system health", enum: SYNO_OK },
  { oid: "1.3.6.1.4.1.6574.1.2", name: "temperature", mib: "SYNOLOGY-SYSTEM-MIB", description: "System temperature", unit: "°C" },
  { oid: "1.3.6.1.4.1.6574.1.3", name: "powerStatus", mib: "SYNOLOGY-SYSTEM-MIB", description: "Power supply health", enum: SYNO_OK },
  { oid: "1.3.6.1.4.1.6574.1.4.1", name: "systemFanStatus", mib: "SYNOLOGY-SYSTEM-MIB", description: "System fan health", enum: SYNO_OK },
  { oid: "1.3.6.1.4.1.6574.1.4.2", name: "cpuFanStatus", mib: "SYNOLOGY-SYSTEM-MIB", description: "CPU fan health", enum: SYNO_OK },
  { oid: "1.3.6.1.4.1.6574.1.5.1", name: "modelName", mib: "SYNOLOGY-SYSTEM-MIB", description: "NAS model", kind: "text" },
  { oid: "1.3.6.1.4.1.6574.1.5.2", name: "serialNumber", mib: "SYNOLOGY-SYSTEM-MIB", description: "Serial number", kind: "text" },
  { oid: "1.3.6.1.4.1.6574.1.5.3", name: "version", mib: "SYNOLOGY-SYSTEM-MIB", description: "DSM version", kind: "text" },
  { oid: "1.3.6.1.4.1.6574.1.5.4", name: "upgradeAvailable", mib: "SYNOLOGY-SYSTEM-MIB", description: "DSM update available", enum: { 1: "available", 2: "unavailable", 3: "connecting", 4: "disconnected", 5: "others" } },
  ...table("1.3.6.1.4.1.6574.2.1.1", "SYNOLOGY-DISK-MIB", {
    2: ["diskID", "Disk name", { kind: "text" }],
    3: ["diskModel", "Disk model", { kind: "text" }],
    5: ["diskStatus", "Disk health", { enum: { 1: "normal", 2: "initialized", 3: "notInitialized", 4: "systemPartitionFailed", 5: "crashed" } }],
    6: ["diskTemperature", "Disk temperature", { unit: "°C" }],
  }),
  ...table("1.3.6.1.4.1.6574.3.1.1", "SYNOLOGY-RAID-MIB", {
    2: ["raidName", "Storage pool / volume name", { kind: "text" }],
    3: ["raidStatus", "Pool health", { enum: { 1: "normal", 2: "repairing", 3: "migrating", 4: "expanding", 5: "deleting", 6: "creating", 7: "raidSyncing", 8: "raidParityChecking", 9: "raidAssembling", 10: "canceling", 11: "degrade", 12: "crashed" } }],
  }),

  // ---- APC PowerNet ----
  { oid: "1.3.6.1.4.1.318.1.1.1.1.1.1", name: "upsBasicIdentModel", mib: "PowerNet-MIB", description: "UPS model", kind: "text" },
  { oid: "1.3.6.1.4.1.318.1.1.1.2.1.1", name: "upsBasicBatteryStatus", mib: "PowerNet-MIB", description: "Battery state", enum: { 1: "unknown", 2: "batteryNormal", 3: "batteryLow", 4: "batteryInFaultCondition" } },
  { oid: "1.3.6.1.4.1.318.1.1.1.2.2.1", name: "upsAdvBatteryCapacity", mib: "PowerNet-MIB", description: "Battery charge", unit: "%" },
  { oid: "1.3.6.1.4.1.318.1.1.1.2.2.2", name: "upsAdvBatteryTemperature", mib: "PowerNet-MIB", description: "Battery temperature", unit: "°C" },
  { oid: "1.3.6.1.4.1.318.1.1.1.2.2.3", name: "upsAdvBatteryRunTimeRemaining", mib: "PowerNet-MIB", description: "Runtime left on battery", kind: "timeticks" },
  { oid: "1.3.6.1.4.1.318.1.1.1.2.2.4", name: "upsAdvBatteryReplaceIndicator", mib: "PowerNet-MIB", description: "Battery needs replacing", enum: { 1: "noBatteryNeedsReplacing", 2: "batteryNeedsReplacing" } },
  { oid: "1.3.6.1.4.1.318.1.1.1.3.2.1", name: "upsAdvInputLineVoltage", mib: "PowerNet-MIB", description: "Mains input voltage", unit: " V" },
  { oid: "1.3.6.1.4.1.318.1.1.1.4.1.1", name: "upsBasicOutputStatus", mib: "PowerNet-MIB", description: "Output state", enum: { 1: "unknown", 2: "onLine", 3: "onBattery", 4: "onSmartBoost", 5: "timedSleeping", 6: "softwareBypass", 7: "off", 8: "rebooting", 9: "switchedBypass", 10: "hardwareFailureBypass", 11: "sleepingUntilPowerReturn", 12: "onSmartTrim" } },
  { oid: "1.3.6.1.4.1.318.1.1.1.4.2.3", name: "upsAdvOutputLoad", mib: "PowerNet-MIB", description: "Output load", unit: "%" },

  // ---- Cisco ----
  ...table("1.3.6.1.4.1.9.9.109.1.1.1.1", "CISCO-PROCESS-MIB", { 6: ["cpmCPUTotal5secRev", "CPU busy, last 5 seconds", { unit: "%" }], 7: ["cpmCPUTotal1minRev", "CPU busy, last minute", { unit: "%" }], 8: ["cpmCPUTotal5minRev", "CPU busy, last 5 minutes", { unit: "%" }] }),
  ...table("1.3.6.1.4.1.9.9.48.1.1.1", "CISCO-MEMORY-POOL-MIB", { 2: ["ciscoMemoryPoolName", "Memory pool name", { kind: "text" }], 5: ["ciscoMemoryPoolUsed", "Memory pool used", { kind: "bytes" }], 6: ["ciscoMemoryPoolFree", "Memory pool free", { kind: "bytes" }] }),
  { oid: "1.3.6.1.4.1.9.9.13.1.3.1.3", name: "ciscoEnvMonTemperatureStatusValue", mib: "CISCO-ENVMON-MIB", description: "Temperature sensor reading", unit: "°C", column: true },
  { oid: "1.3.6.1.4.1.9.9.13.1.4.1.3", name: "ciscoEnvMonFanState", mib: "CISCO-ENVMON-MIB", description: "Fan state", enum: CISCO_ENV, column: true },
  { oid: "1.3.6.1.4.1.9.9.13.1.5.1.3", name: "ciscoEnvMonSupplyState", mib: "CISCO-ENVMON-MIB", description: "Power supply state", enum: CISCO_ENV, column: true },

  // ---- Printer vendors (beyond the standard Printer-MIB above, which every
  // major brand implements). Vendor counters vary by model and firmware —
  // confirm with "Walk this device" before relying on one. ----
  { oid: "1.3.6.1.4.1.367.3.2.1.2.19.1", name: "ricohEngCounterTotal", mib: "RICOH-MIB", description: "Ricoh: total pages counted by the engine (varies by model — confirm with Walk)", kind: "counter" },
  { oid: "1.3.6.1.4.1.253.8.53.13.2.1.6.1.20", name: "xcmHrDevDetailValueInteger", mib: "XEROX-HOST-RESOURCES-EXT-MIB", description: "Xerox: device counters (row 1 = total impressions on most models — confirm with Walk)", column: true, kind: "counter" },
  { oid: "1.3.6.1.4.1.1602.1.11.1.3.1.4", name: "canonCounterValue", mib: "CANON-MIB", description: "Canon: billing counters (row 101 = total on most imageRUNNER models — confirm with Walk)", column: true, kind: "counter" },
  { oid: "1.3.6.1.4.1.11.2.3.9.4.2", name: "hpPrinterDevice", mib: "HP-LASERJET-COMMON-MIB", description: "HP: printer status and counters (varies by model — confirm with Walk)" },
  { oid: "1.3.6.1.4.1.2435.2.3.9", name: "brNetConfig", mib: "BROTHER-MIB", description: "Brother: printer settings and maintenance counters (varies by model — confirm with Walk)" },
  { oid: "1.3.6.1.4.1.1347.43", name: "kyoceraPrinter", mib: "KYOCERA-MIB", description: "Kyocera: printer counters and status (varies by model — confirm with Walk)" },
  { oid: "1.3.6.1.4.1.641.2", name: "lexmarkPrinter", mib: "LEXMARK-MIB", description: "Lexmark: printer status and counters (varies by model — confirm with Walk)" },
  { oid: "1.3.6.1.4.1.18334.1.1.1", name: "kmPrinter", mib: "KONICA-MINOLTA-MIB", description: "Konica Minolta: printer counters (varies by model — confirm with Walk)" },

  // ---- Dell iDRAC ----
  { oid: "1.3.6.1.4.1.674.10892.5.2.1", name: "globalSystemStatus", mib: "IDRAC-MIB", description: "Overall server health", enum: { 1: "other", 2: "unknown", 3: "ok", 4: "nonCritical", 5: "critical", 6: "nonRecoverable" } },
  { oid: "1.3.6.1.4.1.674.10892.5.2.4", name: "systemPowerState", mib: "IDRAC-MIB", description: "Server power", enum: { 1: "other", 2: "unknown", 3: "off", 4: "on" } },
];

/**
 * IANA enterprise numbers of common vendors: every vendor-specific OID
 * starts 1.3.6.1.4.1.<number>, and a device's sysObjectID names its vendor
 * the same way. Printer makers first, then network, server, storage and UPS
 * vendors.
 */
export const ENTERPRISES: Record<number, string> = {
  // Printers and copiers
  11: "HP",
  236: "Samsung",
  253: "Xerox",
  367: "Ricoh",
  641: "Lexmark",
  1129: "Toshiba",
  1248: "Epson",
  1347: "Kyocera",
  1602: "Canon",
  2001: "OKI",
  2385: "Sharp",
  2435: "Brother",
  18334: "Konica Minolta",
  // Network, servers, storage, power
  9: "Cisco",
  171: "D-Link",
  311: "Microsoft",
  318: "APC (Schneider Electric)",
  534: "Eaton",
  674: "Dell",
  2011: "Huawei",
  2021: "Net-SNMP (UCD)",
  2636: "Juniper",
  4413: "Broadcom",
  4526: "Netgear",
  5624: "Enterasys / Extreme",
  6574: "Synology",
  6876: "VMware",
  8072: "Net-SNMP",
  9303: "Mitsubishi",
  10002: "Ubiquiti",
  11863: "TP-Link",
  12356: "Fortinet",
  14823: "Aruba (HPE)",
  14988: "MikroTik",
  24681: "QNAP",
  25461: "Palo Alto Networks",
  41112: "Ubiquiti (UniFi)",
  12325: "pfSense / FreeBSD",
};

/** The vendor for a "1.3.6.1.4.1.<n>…" OID, or null. */
export function vendorOf(oid: string): { number: number; vendor: string } | null {
  const m = /^\.?1\.3\.6\.1\.4\.1\.(\d+)/.exec(oid);
  if (!m) return null;
  const n = Number(m[1]);
  const vendor = own(ENTERPRISES, n);
  return vendor ? { number: n, vendor } : null;
}

/**
 * Whether text is a numeric OID: two or more runs of digits separated by
 * dots, with an optional leading dot — "1.3.6.1.2.1.1.3.0" or
 * ".1.3.6.1.4.1.2435". Checked piece by piece (no pattern with nested
 * repetition), at most 128 pieces.
 */
export function isOid(text: string): boolean {
  const parts = text.replace(/^\./, "").split(".");
  return parts.length >= 2 && parts.length <= 128 && parts.every((p) => /^\d{1,10}$/.test(p));
}

// Entries by OID, for the longest-prefix lookup below.
const BY_OID = new Map(MIBS.map((m) => [m.oid, m]));

/**
 * What an OID is: the dictionary entry it falls under (the longest matching
 * prefix) and the rest of the OID — the row ("instance") for a table
 * column, ".0" for a single value.
 *
 * @param oid a numeric OID, with or without a leading dot
 */
export function lookupOid(oid: string): { entry: MibEntry; instance: string } | null {
  const parts = oid.replace(/^\./, "").split(".");
  for (let n = parts.length; n > 0; n--) {
    const entry = BY_OID.get(parts.slice(0, n).join("."));
    if (entry) return { entry, instance: parts.slice(n).join(".") };
  }
  return null;
}

/** "3d 4h 12m" from TimeTicks (hundredths of a second). */
function duration(ticks: number): string {
  let s = Math.floor(ticks / 100);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m ${s - m * 60}s`;
}

/** "1.5 GB" from bytes. */
function bytes(n: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  while (Math.abs(n) >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i ? n.toFixed(1) : n} ${units.at(i)}`;
}

/**
 * A readable version of a raw SNMP value using its dictionary entry:
 * named values ("up (1)"), durations, sizes, speeds and units.
 *
 * @param entry the dictionary entry, if known
 * @param raw the value as text (as the walk returns it)
 * @param type the SNMP type ("Counter32", "TimeTicks", "Integer"…)
 */
export function smartValue(entry: MibEntry | undefined, raw: string, type: string): string {
  const n = Number(raw);
  const numeric = raw.trim() !== "" && Number.isFinite(n);
  const named = entry?.enum && numeric ? own(entry.enum, n) : undefined;
  if (named) return `${named} (${n})`;
  if ((entry?.kind === "timeticks" || type === "TimeTicks") && numeric) return duration(n);
  if (!entry || !numeric) return raw;
  if (entry.kind === "bytes") return bytes(n);
  if (entry.kind === "kbytes") return bytes(n * 1024);
  if (entry.kind === "bps") return n >= 1e9 ? `${n / 1e9} Gbps` : n >= 1e6 ? `${n / 1e6} Mbps` : `${n / 1e3} kbps`;
  const scaled = entry.scale ? Math.round(n * entry.scale * 1000) / 1000 : n;
  if (entry.kind === "counter") return `${scaled}${entry.unit ?? ""} (counter — use "as a rate")`;
  return `${scaled}${entry.unit ?? ""}`;
}

/** A walked row with its name and readable value added. */
export type AnnotatedRow = { oid: string; type: string; value: string; name?: string; mib?: string; description?: string; display?: string; hint?: { asRate?: boolean; unit?: string; scale?: number } };

/**
 * Adds names, descriptions, readable values and form hints (counters → "as
 * a rate", units, scales) to walked rows.
 *
 * @param rows rows as the walk returned them
 */
export function annotateWalk(rows: { oid: string; type: string; value: string }[]): AnnotatedRow[] {
  return rows.map((r) => {
    const hit = lookupOid(r.oid);
    if (!hit) {
      // Not in the dictionary, but under a known vendor's number: say whose.
      const v = vendorOf(r.oid);
      return v ? { ...r, name: `${v.vendor} (enterprise ${v.number})`, mib: v.vendor, description: `A ${v.vendor}-specific value not in Looksee's built-in dictionary` } : r;
    }
    const { entry, instance } = hit;
    // sysObjectID's value is itself an OID naming the vendor.
    if (entry.name === "sysObjectID") {
      const v = vendorOf(r.value);
      return { ...r, name: entry.name, mib: entry.mib, description: entry.description, display: v ? `${v.vendor} device (${r.value})` : r.value };
    }
    const counter = entry.kind === "counter" || /^Counter/.test(r.type);
    const unit = entry.kind === "bytes" || entry.kind === "kbytes" ? undefined : entry.unit?.trim() ? entry.unit : undefined;
    return {
      ...r,
      name: `${entry.name}${instance && instance !== "0" ? `.${instance}` : ""}`,
      mib: entry.mib,
      description: entry.description,
      display: smartValue(entry, r.value, r.type),
      hint: { ...(counter ? { asRate: true } : {}), ...(unit ? { unit: counter ? `${unit}/s` : unit } : {}), ...(entry.scale ? { scale: entry.scale } : {}) },
    };
  });
}

/**
 * Finds dictionary entries by name, description or OID — the "Look up an
 * OID" box. Case is ignored; at most 50 results.
 *
 * @param q what to look for, e.g. "ifHCInOctets", "battery", "1.3.6.1.2.1.33"
 */
export function searchOids(q: string): MibEntry[] {
  const query = q.trim().toLowerCase();
  if (!query) return [];
  const hits = MIBS.filter((m) => m.oid.startsWith(query.replace(/^\./, "")) || m.name.toLowerCase().includes(query) || m.description.toLowerCase().includes(query) || m.mib.toLowerCase().includes(query));
  // A vendor name ("brother", "ricoh") also finds that vendor's whole
  // branch, to walk from.
  const vendors = Object.entries(ENTERPRISES)
    .filter(([, name]) => name.toLowerCase().includes(query))
    .map(([n, name]): MibEntry => ({ oid: `1.3.6.1.4.1.${n}`, name: `${name} (enterprise ${n})`, mib: name, description: `Everything ${name}-specific — walk from here to see what this device offers` }));
  return [...hits, ...vendors].slice(0, 50);
}
