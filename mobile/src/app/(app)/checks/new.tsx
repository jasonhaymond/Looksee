// Picking the type of a new check, grouped by category with a search, from the
// shared check-type registry. Choosing one opens the check form. siteId /
// endpointId passed in (from a site or endpoint screen) are handed on, so the
// new check lands there.

import { useState } from "react";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { CATEGORIES, CHECK_TYPES } from "../../../lib/shared";
import { Card, Empty, Field, Row, Screen } from "../../../components/ui";

export default function NewCheck() {
  const params = useLocalSearchParams<{ siteId?: string; endpointId?: string }>();
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const visible = CHECK_TYPES.filter((t) => !t.legacy && (!query || `${t.label} ${t.description} ${t.category} ${t.type}`.toLowerCase().includes(query)));
  return (
    <Screen>
      <Stack.Screen options={{ title: "Add a check" }} />
      <Field label="Search check types" value={q} onChangeText={setQ} placeholder="disk, ssl, docker, backup, printer…" autoCapitalize="none" />
      {CATEGORIES.map((cat) => {
        const types = visible.filter((t) => t.category === cat);
        if (!types.length) return null;
        return (
          <Card key={cat} title={cat}>
            {types.map((t) => (
              <Row key={t.type} title={t.label} subtitle={t.description} onPress={() => router.replace({ pathname: "/checks/edit", params: { type: t.type, ...(params.siteId ? { siteId: params.siteId } : {}), ...(params.endpointId ? { endpointId: params.endpointId } : {}) } })} />
            ))}
          </Card>
        );
      })}
      {visible.length === 0 ? <Empty>No check type matches “{q}”.</Empty> : null}
    </Screen>
  );
}
