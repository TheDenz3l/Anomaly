import { useEffect, useState } from "react";
import { TextInput, View } from "react-native";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Segmented } from "@/components/ui/Segmented";
import { Tap } from "@/components/ui/Tap";
import { Text } from "@/components/ui/Text";
import { ActionButton, GenCard, Pill, type GenProps } from "@/genui/kit";
import type { CatalogProps } from "@/genui/schemas";
import { colors, fonts } from "@/lib/theme";

type Role = CatalogProps<"SubagentPlan">["tasks"][number]["role"];

const roleIcon: Record<Role, IconName> = {
  search: "search",
  reader: "document-text-outline",
  maps: "map-outline",
  code: "code-slash",
  vision: "eye-outline",
  "memory-read": "sparkles-outline",
  verifier: "shield-checkmark-outline",
};

/** Milliseconds since mount while `live`; jumps to the end when replaying a finished thread. */
function useElapsed(live: boolean, total: number): number {
  const [elapsed, setElapsed] = useState(live ? 0 : Number.POSITIVE_INFINITY);
  useEffect(() => {
    if (!live) return;
    const start = Date.now();
    const id = setInterval(() => {
      const e = Date.now() - start;
      setElapsed(e);
      if (e > total) clearInterval(id);
    }, 150);
    return () => clearInterval(id);
  }, [live, total]);
  return elapsed;
}

function tokens(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function SubagentPlan({ props, emit, events, busy }: GenProps<"SubagentPlan">) {
  const decided = events.at(-1)?.action;
  const [enabled, setEnabled] = useState<string[]>(props.tasks.map((t) => t.id));
  const active = props.tasks.filter((t) => enabled.includes(t.id));
  const share =
    active.reduce((s, t) => s + t.estTokens, 0) / props.tasks.reduce((s, t) => s + t.estTokens, 0);
  const cost = props.costEstimateUsd * share;

  return (
    <GenCard
      title="Sub-agent plan"
      subtitle={props.goal}
      icon="git-network-outline"
      right={
        decided ? (
          <Pill
            label={decided === "approve" ? "Approved" : "Cancelled"}
            tone={decided === "approve" ? "success" : "neutral"}
          />
        ) : undefined
      }
    >
      <View className="gap-1">
        {props.tasks.map((t) => {
          const on = enabled.includes(t.id);
          return (
            <Tap
              key={t.id}
              disabled={Boolean(decided)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              accessibilityLabel={`${t.role} worker: ${t.brief}`}
              onPress={() => setEnabled((s) => (on ? s.filter((x) => x !== t.id) : [...s, t.id]))}
              className="flex-row items-center gap-3 py-2"
              style={{ opacity: on ? 1 : 0.45 }}
            >
              <View className="h-9 w-9 items-center justify-center rounded-full bg-raised">
                <Icon name={roleIcon[t.role]} size={16} color={colors.textMuted} />
              </View>
              <View className="flex-1">
                <Text weight="medium" className="text-[15px] leading-5">
                  {t.brief}
                </Text>
                <Text muted className="text-xs">
                  {t.model}, about {tokens(t.estTokens)} tokens
                </Text>
              </View>
              {!decided ? (
                <Icon
                  name={on ? "checkmark-circle" : "ellipse-outline"}
                  size={22}
                  color={on ? colors.primary : colors.textFaint}
                />
              ) : null}
            </Tap>
          );
        })}
      </View>
      <View className="mt-3 flex-row items-center justify-between rounded-2xl bg-raised px-3 py-2.5">
        <View>
          <Text muted className="text-[11px]">
            Estimated cost
          </Text>
          <Text weight="bold" className="text-[17px]">
            ${cost.toFixed(2)}
          </Text>
        </View>
        <View className="items-end">
          <Text muted className="text-[11px]">
            Caps
          </Text>
          <Text weight="medium" className="text-[13px]">
            {tokens(props.budget.maxTokens)} tokens, {props.budget.maxSearches} searches,{" "}
            {props.budget.maxMinutes} min
          </Text>
        </View>
      </View>
      {!decided ? (
        <View className="mt-3 flex-row justify-end gap-2">
          <ActionButton
            variant="ghost"
            size="sm"
            label="Cancel"
            disabled={busy}
            onPress={() => emit("cancel", "Cancelled the sub-agent plan")}
          />
          <ActionButton
            size="sm"
            label={`Run ${active.length} workers`}
            disabled={busy || active.length === 0}
            onPress={() =>
              emit("approve", `Approved ${active.length} workers`, {
                tasks: active.map((t) => t.id),
              })
            }
          />
        </View>
      ) : null}
    </GenCard>
  );
}

type RunStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export function SubagentTimeline({ props, emit, live }: GenProps<"SubagentTimeline">) {
  const total = Math.max(...props.runs.map((r) => r.durationMs));
  const elapsed = useElapsed(props.live && live, total);
  const [cancelled, setCancelled] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  const startOf = (i: number, role: Role) =>
    role === "verifier" ? Math.min(3200, total * 0.45) : i * 260;
  const statusOf = (r: (typeof props.runs)[number], i: number): RunStatus => {
    if (cancelled.includes(r.id)) return "cancelled";
    if (elapsed < startOf(i, r.role)) return "queued";
    if (elapsed < r.durationMs) return "running";
    return r.outcome;
  };
  const statuses = props.runs.map(statusOf);
  const running = statuses.some((s) => s === "running" || s === "queued");

  const tone: Record<RunStatus, "neutral" | "primary" | "success" | "danger"> = {
    queued: "neutral",
    running: "primary",
    done: "success",
    failed: "danger",
    cancelled: "neutral",
  };
  const label: Record<RunStatus, string> = {
    queued: "Queued",
    running: "Running",
    done: "Done",
    failed: "Partial",
    cancelled: "Cancelled",
  };

  return (
    <GenCard
      title="Workers"
      subtitle={
        running
          ? "Running in parallel, max depth 1"
          : `${statuses.filter((s) => s === "done").length} of ${props.runs.length} finished cleanly`
      }
      icon="git-network-outline"
      right={
        running ? (
          <ActionButton
            size="sm"
            variant="danger-soft"
            label="Stop all"
            onPress={() => {
              setCancelled(props.runs.map((r) => r.id));
              emit("cancel_run", "Stopped all workers", { ids: props.runs.map((r) => r.id) });
            }}
          />
        ) : undefined
      }
    >
      <View className="gap-1">
        {props.runs.map((r, i) => {
          const s = statuses[i];
          const start = startOf(i, r.role);
          const progress =
            s === "running"
              ? Math.min(1, (elapsed - start) / (r.durationMs - start))
              : s === "queued"
                ? 0
                : 1;
          const finished = s === "done" || s === "failed";
          const expanded = open === r.id && finished;
          return (
            <View key={r.id} className="py-2">
              <Tap
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                disabled={!finished}
                onPress={() => setOpen(expanded ? null : r.id)}
                className="flex-row items-center gap-3"
              >
                <View
                  className={`h-9 w-9 items-center justify-center rounded-full ${s === "running" ? "bg-primary-soft" : "bg-raised"}`}
                >
                  <Icon
                    name={roleIcon[r.role]}
                    size={16}
                    color={s === "running" ? colors.primaryStrong : colors.textMuted}
                  />
                </View>
                <View className="flex-1">
                  <Text
                    weight="medium"
                    className="text-[15px] leading-5"
                    numberOfLines={expanded ? undefined : 1}
                  >
                    {r.brief}
                  </Text>
                  <Text muted className="text-xs">
                    {r.model}, {Math.round(r.sourcesRead * progress)}{" "}
                    {Math.round(r.sourcesRead * progress) === 1 ? "source" : "sources"},{" "}
                    {tokens(Math.round(r.tokens * progress))} tokens
                  </Text>
                </View>
                {s === "running" ? (
                  <Tap
                    accessibilityLabel={`Cancel ${r.brief}`}
                    hitSlop={8}
                    onPress={() => {
                      setCancelled((c) => [...c, r.id]);
                      emit("cancel_run", `Cancelled worker: ${r.brief}`, { ids: [r.id] });
                    }}
                  >
                    <Icon name="close-circle" size={20} color={colors.textFaint} />
                  </Tap>
                ) : (
                  <Pill label={label[s]} tone={tone[s]} />
                )}
              </Tap>
              {s === "running" ? (
                <View className="ml-12 mt-2 h-1 overflow-hidden rounded-full bg-raised">
                  <View
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${progress * 100}%` }}
                  />
                </View>
              ) : null}
              {expanded ? (
                <View className="ml-12 mt-2 rounded-2xl bg-raised p-3">
                  <Text className="text-sm leading-5">{r.result}</Text>
                </View>
              ) : null}
            </View>
          );
        })}
      </View>
    </GenCard>
  );
}

export function ResearchPlan({ props, emit, events, busy }: GenProps<"ResearchPlan">) {
  const started = events.length > 0;
  const [steps, setSteps] = useState(props.steps);
  const [depth, setDepth] = useState(String(props.depth) as "1" | "2" | "3");
  const [editing, setEditing] = useState<string | null>(null);
  const cost =
    (props.budgetUsd / props.steps.length) * steps.length * (Number(depth) / props.depth);

  return (
    <GenCard
      title="Research plan"
      subtitle={props.question}
      icon="telescope-outline"
      right={started ? <Pill label="Started" tone="success" /> : undefined}
    >
      <View className="gap-1">
        {steps.map((s, i) => (
          <View key={s.id} className="flex-row gap-3 py-2">
            <Text weight="bold" className="w-5 pt-0.5 text-sm text-primary-strong">
              {i + 1}
            </Text>
            <View className="flex-1">
              {editing === s.id ? (
                <TextInput
                  autoFocus
                  value={s.title}
                  onChangeText={(title) =>
                    setSteps((all) => all.map((x) => (x.id === s.id ? { ...x, title } : x)))
                  }
                  onBlur={() => setEditing(null)}
                  onSubmitEditing={() => setEditing(null)}
                  accessibilityLabel={`Edit step ${i + 1}`}
                  style={{ fontFamily: fonts.medium, fontSize: 15, color: colors.text, padding: 0 }}
                />
              ) : (
                <Text weight="medium" className="text-[15px] leading-5">
                  {s.title}
                </Text>
              )}
              <Text muted className="mt-0.5 text-xs leading-4" numberOfLines={1}>
                {s.queries.join(", ")}
              </Text>
            </View>
            {!started ? (
              <View className="flex-row gap-3 pt-0.5">
                <Tap
                  accessibilityLabel={`Edit step ${i + 1}`}
                  hitSlop={6}
                  onPress={() => setEditing(s.id)}
                >
                  <Icon name="pencil" size={16} color={colors.textMuted} />
                </Tap>
                <Tap
                  accessibilityLabel={`Remove step ${i + 1}`}
                  hitSlop={6}
                  disabled={steps.length === 1}
                  onPress={() => setSteps((all) => all.filter((x) => x.id !== s.id))}
                >
                  <Icon
                    name="trash-outline"
                    size={16}
                    color={steps.length === 1 ? colors.raised : colors.textMuted}
                  />
                </Tap>
              </View>
            ) : null}
          </View>
        ))}
      </View>
      {!started ? (
        <>
          <View className="mt-3 gap-2">
            <Text muted weight="medium" className="text-[13px]">
              Depth
            </Text>
            <Segmented
              accessibilityLabel="Research depth"
              value={depth}
              onChange={setDepth}
              options={[
                { value: "1", label: "Quick" },
                { value: "2", label: "Standard" },
                { value: "3", label: "Deep" },
              ]}
            />
          </View>
          <View className="mt-4 flex-row items-center justify-between">
            <View>
              <Text weight="bold" className="text-[15px]">
                About ${cost.toFixed(2)}
              </Text>
              <Text muted className="text-xs">
                Charged to your own key
              </Text>
            </View>
            <ActionButton
              label="Start research"
              icon="play"
              disabled={busy}
              onPress={() =>
                emit("start", `Started research with ${steps.length} steps`, {
                  steps: steps.map((s) => s.title),
                  depth: Number(depth),
                })
              }
            />
          </View>
        </>
      ) : null}
    </GenCard>
  );
}

const phases = [
  { id: "clarify", label: "Clarify", end: 0 },
  { id: "plan", label: "Plan", end: 0 },
  { id: "search", label: "Search and read", end: 0.55 },
  { id: "reflect", label: "Reflect", end: 0.7 },
  { id: "synthesize", label: "Synthesize", end: 0.88 },
  { id: "verify", label: "Verify citations", end: 1 },
];

export function ResearchProgress({ props, live }: GenProps<"ResearchProgress">) {
  const elapsed = useElapsed(props.live && live, props.durationMs);
  const p = Math.min(1, elapsed / props.durationMs);
  const found = Math.round(props.sourcesFound * Math.min(1, p / 0.55));
  const done = p >= 1;

  return (
    <GenCard
      title="Deep research"
      subtitle={
        done
          ? `Kept ${props.sourcesKept} of ${props.sourcesFound} sources`
          : `${found} sources found so far`
      }
      icon="telescope-outline"
      right={
        done ? (
          <Pill label="Complete" tone="success" icon="checkmark" />
        ) : (
          <Pill label={`${Math.round(p * 100)}%`} tone="primary" />
        )
      }
    >
      <View className="mb-4 h-1.5 overflow-hidden rounded-full bg-raised">
        <View className="h-full rounded-full bg-primary" style={{ width: `${p * 100}%` }} />
      </View>
      <View className="gap-2.5">
        {phases.map((ph, i) => {
          const prevEnd = i === 0 ? 0 : phases[i - 1].end;
          const state =
            p >= ph.end && (ph.end > 0 || p > 0) ? "done" : p >= prevEnd ? "active" : "todo";
          return (
            <View key={ph.id} className="flex-row items-center gap-3">
              <View
                className={`h-5 w-5 items-center justify-center rounded-full ${state === "done" ? "bg-primary" : state === "active" ? "border-2 border-primary" : "border-2 border-raised"}`}
              >
                {state === "done" ? <Icon name="checkmark" size={12} color="#fff" /> : null}
              </View>
              <Text
                weight={state === "active" ? "bold" : "medium"}
                muted={state === "todo"}
                className="flex-1 text-[15px]"
              >
                {ph.label}
              </Text>
            </View>
          );
        })}
      </View>
      <View className="mt-4 flex-row flex-wrap gap-2">
        {props.workers.map((w, i) => {
          const wp = Math.min(1, Math.max(0, (p - i * 0.04) / 0.55));
          return (
            <View
              key={w.id}
              className="flex-row items-center gap-1.5 rounded-full bg-raised px-3 py-1.5"
            >
              <View
                className={`h-1.5 w-1.5 rounded-full ${wp >= 1 ? "bg-success" : "bg-primary"}`}
              />
              <Text weight="medium" className="text-xs">
                {w.label}
              </Text>
              <Text muted className="text-xs">
                {Math.round(w.sources * wp)}
              </Text>
            </View>
          );
        })}
      </View>
    </GenCard>
  );
}
