// The settings of an alert rule: which channels it notifies, after how many
// failing results in a row, whether warn counts as failing, reminders while it
// stays failing, and escalation to more channels after a while. Used on a
// check's screen (add/edit a rule), when creating checks, and for bulk "add
// alert rule".
//
// Includes the "Notifications" option: while no Notifications channel exists,
// ticking it creates one (every browser with push on and every phone with
// this app) and selects it.

import { useState } from "react";
import { View } from "react-native";
import { api, type Channel } from "../lib/shared";
import { errorText } from "../lib/format";
import { Chip, Chips, ErrorBox, Field, T } from "./ui";

export type RuleValue = { channelIds: string[]; escalationChannelIds: string[]; consecutiveFailures: string; triggerOn: "down" | "warn"; renotifyMinutes: string; escalateAfterMinutes: string };

export const emptyRule = (): RuleValue => ({ channelIds: [], escalationChannelIds: [], consecutiveFailures: "2", triggerOn: "down", renotifyMinutes: "", escalateAfterMinutes: "" });

/** Form values as the API expects them (numbers; escalation channels only with a delay). */
export const rulePayload = (v: RuleValue) => ({
  channelIds: v.channelIds,
  escalationChannelIds: v.escalateAfterMinutes ? v.escalationChannelIds : [],
  consecutiveFailures: Math.max(1, Number(v.consecutiveFailures) || 2),
  triggerOn: v.triggerOn,
  renotifyMinutes: v.renotifyMinutes ? Number(v.renotifyMinutes) : null,
  escalateAfterMinutes: v.escalateAfterMinutes ? Number(v.escalateAfterMinutes) : null,
});

/**
 * @param channels the channels to choose from
 * @param onChannelCreated called with the Notifications channel when the option created it
 */
export function AlertRuleForm({ value, onChange, channels, onChannelCreated }: { value: RuleValue; onChange: (v: RuleValue) => void; channels: Channel[]; onChannelCreated: (c: Channel) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const set = <K extends keyof RuleValue>(k: K, v: RuleValue[K]) => onChange({ ...value, [k]: v });
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const hasNotifications = channels.some((c) => c.type === "web_push");

  /** Creates the Notifications channel (browsers + phones) and selects it. */
  async function addNotifications() {
    setCreating(true);
    setError(null);
    try {
      const channel = await api.createChannel({ name: "Notifications", type: "web_push", config: {} });
      onChannelCreated(channel);
      onChange({ ...value, channelIds: [...value.channelIds, channel.id] });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <View style={{ gap: 10 }}>
      <T size="s" muted>Notify</T>
      <Chips>
        {channels.map((c) => (
          <Chip key={c.id} label={`${c.name}${c.type === "web_push" && c.name !== "Notifications" ? " (notifications)" : ""}`} on={value.channelIds.includes(c.id)} onPress={() => set("channelIds", toggle(value.channelIds, c.id))} />
        ))}
        {!hasNotifications ? <Chip label={creating ? "Adding…" : "+ Notifications (this app and browsers)"} on={false} onPress={addNotifications} /> : null}
      </Chips>
      {channels.length === 0 ? <T size="s" muted>No channels yet. Add Notifications above, or other channels under More → Channels.</T> : null}
      <ErrorBox error={error} />
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Field label="Failing results in a row" value={value.consecutiveFailures} onChangeText={(t) => set("consecutiveFailures", t)} keyboardType="number-pad" />
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <T size="s" muted>Failing means</T>
          <Chips>
            <Chip label="Down" on={value.triggerOn === "down"} onPress={() => set("triggerOn", "down")} />
            <Chip label="Warn or down" on={value.triggerOn === "warn"} onPress={() => set("triggerOn", "warn")} />
          </Chips>
        </View>
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Field label="Remind every (min)" value={value.renotifyMinutes} onChangeText={(t) => set("renotifyMinutes", t)} keyboardType="number-pad" placeholder="once" />
        </View>
        <View style={{ flex: 1 }}>
          <Field label="Escalate after (min)" value={value.escalateAfterMinutes} onChangeText={(t) => set("escalateAfterMinutes", t)} keyboardType="number-pad" placeholder="never" />
        </View>
      </View>
      {value.escalateAfterMinutes ? (
        <>
          <T size="s" muted>Escalate to</T>
          <Chips>
            {channels.map((c) => (
              <Chip key={c.id} label={c.name} on={value.escalationChannelIds.includes(c.id)} onPress={() => set("escalationChannelIds", toggle(value.escalationChannelIds, c.id))} />
            ))}
          </Chips>
        </>
      ) : null}
    </View>
  );
}
