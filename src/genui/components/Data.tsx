import { useState } from "react";
import { ScrollView, View } from "react-native";
import { Icon } from "@/components/ui/Icon";
import { Tap } from "@/components/ui/Tap";
import { Text } from "@/components/ui/Text";
import { GenCard, type GenProps } from "@/genui/kit";
import { colors } from "@/lib/theme";

const num = (v: string | number) =>
  typeof v === "number" ? v : parseFloat(String(v).replace(/[^0-9.-]/g, ""));

/** Sortable table — tap a column header to sort. Scrolls sideways on narrow screens. */
export function Table({ props }: GenProps<"Table">) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const rows = sort
    ? [...props.rows].sort((a, b) => {
        const col = props.columns.find((c) => c.key === sort.key);
        const av = a[sort.key] ?? "";
        const bv = b[sort.key] ?? "";
        const cmp = col?.numeric ? num(av) - num(bv) : String(av).localeCompare(String(bv));
        return cmp * sort.dir;
      })
    : props.rows;

  return (
    <GenCard
      title={props.title}
      icon="grid-outline"
      flush
      footer={
        props.caption ? (
          <Text muted className="text-xs leading-4">
            {props.caption}
          </Text>
        ) : undefined
      }
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 12 }}
      >
        <View>
          <View className="flex-row border-b border-hairline pb-2">
            {props.columns.map((c, i) => {
              const active = sort?.key === c.key;
              return (
                <Tap
                  key={c.key}
                  accessibilityRole="button"
                  accessibilityLabel={`Sort by ${c.label}`}
                  onPress={() =>
                    setSort(
                      active ? { key: c.key, dir: sort.dir === 1 ? -1 : 1 } : { key: c.key, dir: 1 }
                    )
                  }
                  className={`flex-row items-center gap-1 ${c.numeric ? "justify-end" : ""}`}
                  style={{ width: i === 0 ? 150 : 104 }}
                >
                  <Text weight="bold" muted={!active} className="text-xs">
                    {c.label}
                  </Text>
                  {active ? (
                    <Icon
                      name={sort.dir === 1 ? "arrow-up" : "arrow-down"}
                      size={11}
                      color={colors.text}
                    />
                  ) : null}
                </Tap>
              );
            })}
          </View>
          {rows.map((r, ri) => (
            <View
              key={ri}
              className={`flex-row py-2.5 ${ri < rows.length - 1 ? "border-b border-hairline" : ""}`}
            >
              {props.columns.map((c, i) => (
                <Text
                  key={c.key}
                  weight={i === 0 ? "bold" : "regular"}
                  className={`text-sm leading-5 ${c.numeric ? "text-right" : ""}`}
                  style={{ width: i === 0 ? 150 : 104, paddingRight: 8 }}
                >
                  {String(r[c.key] ?? "")}
                </Text>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </GenCard>
  );
}

export function Compare({ props }: GenProps<"Compare">) {
  return (
    <GenCard title={props.title ?? "Comparison"} icon="git-compare-outline">
      <View className="flex-row gap-2">
        {props.items.map((it) => (
          <View key={it.id} className="flex-1 rounded-2xl bg-raised px-3 py-2.5">
            <Text weight="bold" className="text-[15px]" numberOfLines={1}>
              {it.name}
            </Text>
            {it.subtitle ? (
              <Text muted className="text-xs">
                {it.subtitle}
              </Text>
            ) : null}
          </View>
        ))}
      </View>
      <View className="mt-3">
        {props.rows.map((row, ri) => (
          <View
            key={row.label}
            className={`py-2.5 ${ri < props.rows.length - 1 ? "border-b border-hairline" : ""}`}
          >
            <Text muted className="mb-1 text-xs">
              {row.label}
            </Text>
            <View className="flex-row gap-2">
              {row.values.map((v, i) => {
                const win = row.winner === i;
                return (
                  <View key={i} className="flex-1 flex-row items-center gap-1.5 px-1">
                    {win ? (
                      <View
                        accessibilityLabel="Better"
                        className="h-1.5 w-1.5 rounded-full bg-primary"
                      />
                    ) : null}
                    <Text
                      weight={win ? "bold" : "regular"}
                      muted={!win && row.winner !== undefined}
                      className="flex-1 text-sm leading-5"
                    >
                      {v}
                    </Text>
                  </View>
                );
              })}
            </View>
          </View>
        ))}
      </View>
      {props.verdict ? (
        <View className="mt-3 rounded-2xl bg-primary-soft p-3">
          <Text weight="medium" className="text-sm leading-5">
            {props.verdict}
          </Text>
        </View>
      ) : null}
    </GenCard>
  );
}

export function Timeline({ props }: GenProps<"Timeline">) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <GenCard title={props.title ?? "Timeline"} icon="time-outline">
      {props.events.map((e, i) => {
        const last = i === props.events.length - 1;
        const expanded = open === i;
        return (
          <Tap
            key={i}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            onPress={() => setOpen(expanded ? null : i)}
            disabled={!e.detail}
            className="flex-row gap-3"
          >
            <View className="w-12 pt-0.5">
              <Text weight="bold" className="text-[13px] text-primary-strong">
                {e.date}
              </Text>
            </View>
            <View className="items-center">
              <View
                className={`mt-1.5 h-2.5 w-2.5 rounded-full ${expanded ? "bg-primary" : "bg-[#52525B]"}`}
              />
              {!last ? <View className="w-px flex-1 bg-raised" /> : null}
            </View>
            <View className={`flex-1 ${last ? "" : "pb-4"}`}>
              <Text weight={expanded ? "bold" : "medium"} className="text-[15px] leading-5">
                {e.title}
              </Text>
              {expanded && e.detail ? (
                <Text muted className="mt-1 text-sm leading-5">
                  {e.detail}
                </Text>
              ) : null}
            </View>
          </Tap>
        );
      })}
    </GenCard>
  );
}
