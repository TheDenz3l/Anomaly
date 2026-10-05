import type { ComponentProps } from "react";
import { Text as RNText } from "react-native";
import { twMerge } from "tailwind-merge";

type Weight = "regular" | "medium" | "bold" | "italic";

const weightClass: Record<Weight, string> = {
  regular: "font-body",
  medium: "font-body-medium",
  bold: "font-body-bold",
  italic: "font-body-italic",
};

type Props = ComponentProps<typeof RNText> & { weight?: Weight; muted?: boolean };

/** Satoshi text. Regular for body, bold for emphasis, labels and key values (PRD §2.3). */
export function Text({ weight = "regular", muted, className, ...rest }: Props) {
  return (
    <RNText
      {...rest}
      className={twMerge(weightClass[weight], muted ? "text-ink-muted" : "text-ink", className)}
    />
  );
}

/** Moderniz — app title, thread titles, component titles. Use sparingly. */
export function Display({ className, ...rest }: ComponentProps<typeof RNText>) {
  return <RNText {...rest} className={twMerge("font-display text-ink", className)} />;
}
