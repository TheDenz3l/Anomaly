import { Image } from "expo-image";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { GeneratedArt } from "@/components/ui/GeneratedArt";
import { Icon } from "@/components/ui/Icon";
import { Tap } from "@/components/ui/Tap";
import { Text } from "@/components/ui/Text";
import { ActionButton, GenCard, Pill, type GenProps } from "@/genui/kit";
import { colors } from "@/lib/theme";

function runtime(min: number) {
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

export function MovieShowtimes({ props, emit, events, busy }: GenProps<"MovieShowtimes">) {
  const sent = events.at(-1)?.payload as
    { movieId?: string; theatreId?: string; time?: string } | undefined;
  const [movieId, setMovieId] = useState(sent?.movieId ?? props.movies[0].id);
  const [pick, setPick] = useState<{ theatreId: string; time: string } | null>(
    sent?.theatreId && sent.time ? { theatreId: sent.theatreId, time: sent.time } : null
  );
  const movie = props.movies.find((m) => m.id === movieId) ?? props.movies[0];
  const pickedShow = pick ? movie.showtimes.find((s) => s.theatreId === pick.theatreId) : undefined;
  const locked = Boolean(sent);

  return (
    <GenCard
      title={props.title ?? "Showtimes"}
      subtitle={`${props.date}, ${props.location.charAt(0).toLowerCase()}${props.location.slice(1)}`}
      icon="film-outline"
      flush
      footer={
        <Text muted className="text-xs leading-4">
          {props.attribution}
        </Text>
      }
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16, gap: 10 }}
      >
        {props.movies.map((m) => {
          const active = m.id === movie.id;
          return (
            <Tap
              key={m.id}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`${m.title}, rated ${m.rating}, score ${m.score}`}
              onPress={() => {
                setMovieId(m.id);
                if (!locked) setPick(null);
              }}
              style={{
                borderRadius: 18,
                borderWidth: 2,
                borderColor: active ? colors.primary : "transparent",
                padding: 2,
              }}
            >
              {m.poster ? (
                <Image
                  source={{ uri: m.poster }}
                  accessibilityLabel={`${m.title} poster`}
                  cachePolicy="memory-disk"
                  transition={150}
                  style={{ width: 100, height: 146, borderRadius: 14 }}
                />
              ) : (
                <GeneratedArt
                  seed={m.id}
                  width={100}
                  height={146}
                  title={m.title}
                  caption={m.genres.join(", ")}
                  radius={14}
                />
              )}
            </Tap>
          );
        })}
      </ScrollView>

      <View className="px-4 pt-4">
        <View className="flex-row items-start justify-between gap-3">
          <View className="flex-1">
            <Text weight="bold" className="text-lg leading-6">
              {movie.title}
            </Text>
            <Text muted className="text-[13px] leading-5">
              {movie.year}, {movie.rating}, {runtime(movie.runtime)}
            </Text>
          </View>
          <View className="flex-row items-center gap-1 rounded-full bg-raised px-2.5 py-1">
            <Icon name="star" size={12} color={colors.warning} />
            <Text weight="bold" className="text-[13px]">
              {movie.score.toFixed(1)}
            </Text>
          </View>
        </View>

        <View className="mt-3 gap-4 pb-4">
          {movie.showtimes.map((s) => (
            <View key={s.theatreId} className="gap-2">
              <View className="flex-row items-center gap-2">
                <Text weight="bold" className="text-[15px]" numberOfLines={1}>
                  {s.theatre}
                </Text>
                <Text muted className="text-[13px]">
                  {s.distanceKm} km
                </Text>
                {s.format !== "Standard" ? <Pill label={s.format} tone="primary" /> : null}
              </View>
              <View className="flex-row flex-wrap gap-2">
                {s.times.map((time) => {
                  const on = pick?.theatreId === s.theatreId && pick.time === time;
                  return (
                    <Tap
                      key={time}
                      haptic
                      disabled={locked}
                      accessibilityRole="button"
                      accessibilityState={{ selected: on, disabled: locked }}
                      accessibilityLabel={`${time} at ${s.theatre}`}
                      onPress={() => setPick({ theatreId: s.theatreId, time })}
                      className={`rounded-full px-3.5 py-2 ${on ? "bg-primary" : "bg-raised"}`}
                    >
                      <Text weight="bold" className={`text-sm ${on ? "text-white" : ""}`}>
                        {time}
                      </Text>
                    </Tap>
                  );
                })}
              </View>
            </View>
          ))}
        </View>

        {pick && pickedShow && !locked ? (
          <View className="mb-4 flex-row items-center gap-3 rounded-2xl bg-primary-soft p-3">
            <View className="flex-1">
              <Text weight="bold" className="text-[15px]">
                {pick.time}, {pickedShow.theatre}
              </Text>
              <Text muted className="text-[13px]">
                {movie.title}, {pickedShow.format}
              </Text>
            </View>
            <ActionButton
              size="sm"
              label="Choose"
              disabled={busy}
              onPress={() =>
                emit(
                  "select_showtime",
                  `Picked ${movie.title}, ${pick.time} at ${pickedShow.theatre}`,
                  {
                    movieId: movie.id,
                    movie: movie.title,
                    theatreId: pick.theatreId,
                    theatre: pickedShow.theatre,
                    time: pick.time,
                    distance: `${pickedShow.distanceKm} km`,
                  }
                )
              }
            />
          </View>
        ) : null}
      </View>
    </GenCard>
  );
}
