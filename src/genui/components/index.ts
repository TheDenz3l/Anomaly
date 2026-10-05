import { ResearchPlan, ResearchProgress, SubagentPlan, SubagentTimeline } from "./Agents";
import { Chart } from "./Chart";
import { Compare, Table, Timeline } from "./Data";
import { Checklist, ChoiceChips, Form, Stepper } from "./Interactive";
import { MapCard } from "./MapCard";
import { MovieShowtimes } from "./MovieShowtimes";
import { ProductGrid } from "./ProductGrid";
import { LocationRequest, MemoryConfirm } from "./System";
import { Weather } from "./Weather";

/** Catalog name → native component. Keys must match `catalogSchemas`. */
export const catalogComponents = {
  MovieShowtimes,
  MapCard,
  Chart,
  Table,
  Compare,
  Timeline,
  Form,
  Stepper,
  Checklist,
  ChoiceChips,
  Weather,
  ProductGrid,
  SubagentPlan,
  SubagentTimeline,
  ResearchPlan,
  ResearchProgress,
  LocationRequest,
  MemoryConfirm,
};
