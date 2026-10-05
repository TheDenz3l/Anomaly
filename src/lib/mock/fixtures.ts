import type { CatalogProps } from "@/genui/schemas";
import type { Source } from "@/lib/types";

/* Mock payloads. Shapes match the catalog schemas exactly, so the renderer validates them like real tool calls. */

let sourceSeq = 0;
function src(
  url: string,
  title: string,
  snippet: string,
  origin: Source["origin"] = "app"
): Source {
  sourceSeq += 1;
  return { id: `src_${sourceSeq}`, url, title, snippet, origin };
}

export const HOME = { lat: 43.6487, lng: -79.3963, label: "Queen St W & Spadina Ave" };

export const theatres = [
  {
    id: "scotia",
    name: "Scotiabank Theatre",
    subtitle: "259 Richmond St W",
    lat: 43.649,
    lng: -79.3912,
    distanceKm: 0.4,
  },
  {
    id: "tiff",
    name: "TIFF Lightbox",
    subtitle: "350 King St W",
    lat: 43.6466,
    lng: -79.3903,
    distanceKm: 0.6,
  },
  {
    id: "yd",
    name: "Cineplex Yonge-Dundas",
    subtitle: "10 Dundas St E",
    lat: 43.656,
    lng: -79.3807,
    distanceKm: 1.6,
  },
  {
    id: "carlton",
    name: "Imagine Carlton",
    subtitle: "20 Carlton St",
    lat: 43.6617,
    lng: -79.3812,
    distanceKm: 2.1,
  },
  {
    id: "paradise",
    name: "Paradise Theatre",
    subtitle: "1006 Bloor St W",
    lat: 43.661,
    lng: -79.429,
    distanceKm: 2.9,
  },
];

const t = (id: string) => theatres.find((x) => x.id === id)!;
const show = (
  theatreId: string,
  format: "Standard" | "IMAX" | "Dolby" | "3D",
  times: string[]
) => ({
  theatreId,
  theatre: t(theatreId).name,
  distanceKm: t(theatreId).distanceKm,
  format,
  times,
});

export const movieShowtimes: CatalogProps<"MovieShowtimes"> = {
  title: "Now playing",
  location: "Within 3 km of Queen & Spadina",
  date: "Tonight",
  attribution: "Movie data from TMDB. Times from theatre websites.",
  movies: [
    {
      id: "northbound",
      title: "Northbound",
      year: 2026,
      rating: "14A",
      runtime: 128,
      genres: ["Thriller", "Drama"],
      score: 7.8,
      showtimes: [
        show("scotia", "IMAX", ["4:20 PM", "7:10 PM", "10:15 PM"]),
        show("yd", "Standard", ["5:00 PM", "7:45 PM", "9:30 PM"]),
        show("carlton", "Standard", ["6:15 PM", "8:50 PM"]),
      ],
    },
    {
      id: "meridian",
      title: "The Long Meridian",
      year: 2026,
      rating: "14A",
      runtime: 141,
      genres: ["Sci-fi"],
      score: 8.1,
      showtimes: [
        show("scotia", "Dolby", ["6:30 PM", "9:40 PM"]),
        show("tiff", "Standard", ["7:00 PM"]),
      ],
    },
    {
      id: "glasswing",
      title: "Glasswing",
      year: 2026,
      rating: "PG",
      runtime: 117,
      genres: ["Animation", "Adventure"],
      score: 7.4,
      showtimes: [
        show("scotia", "3D", ["4:00 PM", "6:40 PM"]),
        show("yd", "Standard", ["4:30 PM", "7:00 PM"]),
      ],
    },
    {
      id: "paper-tigers",
      title: "Paper Tigers",
      year: 2026,
      rating: "PG",
      runtime: 104,
      genres: ["Comedy", "Family"],
      score: 6.9,
      showtimes: [
        show("yd", "Standard", ["3:45 PM", "6:00 PM", "8:15 PM"]),
        show("paradise", "Standard", ["5:30 PM"]),
      ],
    },
    {
      id: "halcyon",
      title: "Halcyon Days",
      year: 2026,
      rating: "14A",
      runtime: 112,
      genres: ["Romance", "Drama"],
      score: 7.1,
      showtimes: [
        show("tiff", "Standard", ["6:45 PM", "9:15 PM"]),
        show("paradise", "Standard", ["8:00 PM"]),
      ],
    },
  ],
};

export const theatreMap: CatalogProps<"MapCard"> = {
  title: "Theatres near you",
  center: HOME,
  places: theatres,
};

export const movieSources: Source[] = [
  src(
    "https://www.themoviedb.org/movie/now-playing",
    "Now playing movies",
    "Films currently in theatres, with posters, runtimes and ratings."
  ),
  src(
    "https://overpass-api.de/api/interpreter",
    "OpenStreetMap: cinemas within 3 km",
    "amenity=cinema around 43.6487, -79.3963, radius 3000 m."
  ),
  src(
    "https://www.cineplex.com/theatre/scotiabank-theatre-toronto",
    "Scotiabank Theatre Toronto showtimes",
    "Showtimes for today including IMAX and Dolby screenings."
  ),
  src(
    "https://www.tiff.net/calendar",
    "TIFF Lightbox calendar",
    "Screenings at TIFF Lightbox, 350 King St W."
  ),
  src(
    "https://www.cineplex.com/theatre/cineplex-cinemas-yongedundas",
    "Cineplex Yonge-Dundas showtimes",
    "Today's showtimes at Yonge-Dundas."
  ),
  src(
    "https://imaginecinemas.com/cinema/carlton",
    "Imagine Cinemas Carlton",
    "Showtimes and tickets for Imagine Carlton."
  ),
  src(
    "https://paradiseonbloor.com/calendar",
    "Paradise Theatre calendar",
    "Repertory and first-run screenings on Bloor St W."
  ),
];

export const savingsChart: CatalogProps<"Chart"> = {
  title: "Savings over 20 years",
  subtitle: "$10,000 today, 6% average annual return",
  unit: "currency",
  xLabel: "Year",
  model: {
    type: "compound",
    principal: 10_000,
    annualRate: 0.06,
    years: 20,
    contribution: { label: "Monthly contribution", min: 0, max: 2000, step: 50, value: 500 },
  },
};

export const weatherToronto: CatalogProps<"Weather"> = {
  location: "Toronto",
  updated: "Updated 4 min ago",
  now: {
    tempC: 14,
    feelsLikeC: 12,
    condition: "partly",
    summary: "Sun and cloud, cooling after dark",
    highC: 16,
    lowC: 8,
    windKmh: 18,
    humidity: 62,
    precipChance: 10,
  },
  hourly: [
    { time: "Now", tempC: 14, condition: "partly", precipChance: 10 },
    { time: "5 PM", tempC: 15, condition: "partly", precipChance: 10 },
    { time: "6 PM", tempC: 14, condition: "cloudy", precipChance: 15 },
    { time: "7 PM", tempC: 12, condition: "cloudy", precipChance: 20 },
    { time: "8 PM", tempC: 11, condition: "night", precipChance: 20 },
    { time: "9 PM", tempC: 10, condition: "night", precipChance: 25 },
    { time: "10 PM", tempC: 9, condition: "rain", precipChance: 55 },
    { time: "11 PM", tempC: 9, condition: "rain", precipChance: 60 },
  ],
  daily: [
    { day: "Sat", highC: 17, lowC: 9, condition: "clear" },
    { day: "Sun", highC: 13, lowC: 7, condition: "rain" },
    { day: "Mon", highC: 11, lowC: 5, condition: "cloudy" },
    { day: "Tue", highC: 12, lowC: 4, condition: "partly" },
    { day: "Wed", highC: 15, lowC: 6, condition: "clear" },
  ],
};

export const weatherSources: Source[] = [
  src(
    "https://open-meteo.com/en/docs",
    "Open-Meteo forecast for Toronto",
    "Hourly temperature, precipitation probability and wind for 43.65, -79.38."
  ),
  src(
    "https://weather.gc.ca/city/pages/on-143_metric_e.html",
    "Environment Canada: Toronto",
    "Forecast issued 3:00 PM EDT Saturday."
  ),
];

export const lisbonChecklist: CatalogProps<"Checklist"> = {
  title: "Lisbon, 4 days",
  groups: [
    {
      label: "Documents",
      items: [
        { id: "passport", label: "Passport", checked: true },
        { id: "boarding", label: "Boarding passes in Wallet" },
        { id: "insurance", label: "Travel insurance details" },
      ],
    },
    {
      label: "Clothes",
      items: [
        { id: "shoes", label: "Walking shoes with grip (cobblestones)" },
        { id: "layers", label: "Light layers for windy evenings" },
        { id: "jacket", label: "Packable rain jacket" },
        { id: "swim", label: "Swimsuit for Cascais" },
      ],
    },
    {
      label: "Tech",
      items: [
        { id: "adapter", label: "Type F plug adapter" },
        { id: "battery", label: "Power bank" },
        { id: "esim", label: "eSIM activated before landing" },
      ],
    },
  ],
};

export const headphones: CatalogProps<"ProductGrid"> = {
  title: "Noise-cancelling headphones under $300",
  products: [
    {
      id: "p1",
      name: "WH-1000XM6",
      brand: "Sony",
      price: 279,
      currency: "USD",
      rating: 4.7,
      reviews: 3120,
      store: "Best Buy",
      badge: "Best overall",
    },
    {
      id: "p2",
      name: "QuietComfort Ultra",
      brand: "Bose",
      price: 299,
      currency: "USD",
      rating: 4.6,
      reviews: 2410,
      store: "Amazon",
    },
    {
      id: "p3",
      name: "Momentum 4",
      brand: "Sennheiser",
      price: 229,
      currency: "USD",
      rating: 4.5,
      reviews: 1890,
      store: "Crutchfield",
      badge: "Best battery",
    },
    {
      id: "p4",
      name: "Space One",
      brand: "Soundcore",
      price: 99,
      currency: "USD",
      rating: 4.3,
      reviews: 5602,
      store: "Amazon",
      badge: "Best value",
    },
  ],
};

export const headphoneSources: Source[] = [
  src(
    "https://www.rtings.com/headphones/reviews/best/noise-cancelling",
    "Best noise-cancelling headphones",
    "Lab measurements of ANC attenuation, battery and comfort.",
    "native"
  ),
  src(
    "https://www.soundguys.com/best-noise-cancelling-headphones-1234",
    "The best noise cancelling headphones",
    "Tested picks across budgets.",
    "native"
  ),
  src(
    "https://www.bestbuy.com/site/headphones",
    "Headphones at Best Buy",
    "Current prices and availability.",
    "app"
  ),
];

export const webTimeline: CatalogProps<"Timeline"> = {
  title: "The web in eight moments",
  events: [
    {
      date: "1989",
      title: "Tim Berners-Lee proposes the web",
      detail: "A memo at CERN titled “Information Management: A Proposal”.",
    },
    {
      date: "1991",
      title: "First website goes live",
      detail: "info.cern.ch explains what the World Wide Web is.",
    },
    {
      date: "1993",
      title: "Mosaic browser",
      detail: "Inline images make the web approachable to non-specialists.",
    },
    {
      date: "1995",
      title: "JavaScript ships",
      detail: "Written in ten days for Netscape Navigator 2.0.",
    },
    { date: "1998", title: "Google is founded", detail: "PageRank changes how people find pages." },
    {
      date: "2004",
      title: "Web 2.0",
      detail: "User-generated content and rich web apps take over.",
    },
    { date: "2007", title: "iPhone", detail: "The mobile web becomes the default web." },
    {
      date: "2014",
      title: "HTML5 becomes a W3C Recommendation",
      detail: "Native video, canvas and semantic markup are standardised.",
    },
  ],
};

export const webTimelineSources: Source[] = [
  src(
    "https://home.cern/science/computing/birth-web",
    "The birth of the Web",
    "CERN's history of the World Wide Web.",
    "native"
  ),
  src(
    "https://en.wikipedia.org/wiki/History_of_the_World_Wide_Web",
    "History of the World Wide Web",
    "Wikipedia overview from 1989 onward.",
    "app"
  ),
];

export const bookingForm: CatalogProps<"Form"> = {
  title: "Table request",
  submitLabel: "Review request",
  fields: [
    { id: "restaurant", label: "Restaurant", kind: "text", value: "Bar Isabel", required: true },
    { id: "party", label: "Party size", kind: "number", value: 2, required: true },
    {
      id: "day",
      label: "Day",
      kind: "select",
      options: ["Tonight", "Tomorrow", "Saturday"],
      value: "Saturday",
    },
    {
      id: "time",
      label: "Time",
      kind: "select",
      options: ["6:30 PM", "7:00 PM", "8:15 PM"],
      value: "7:00 PM",
    },
    { id: "patio", label: "Patio if available", kind: "toggle", value: false },
    { id: "notes", label: "Notes", kind: "text", placeholder: "Allergies, occasion…" },
  ],
};

export const wireguardSteps: CatalogProps<"Stepper"> = {
  title: "WireGuard at home",
  steps: [
    {
      title: "Pick the host",
      detail:
        "Use an always-on machine on your network, such as a Raspberry Pi or a NAS that supports Docker.",
    },
    {
      title: "Install WireGuard",
      detail:
        "On Debian or Raspberry Pi OS: sudo apt install wireguard. Generate a key pair with wg genkey.",
    },
    {
      title: "Forward one UDP port",
      detail:
        "In your router, forward UDP 51820 to the host's local IP. Nothing else needs to be open.",
    },
    {
      title: "Add your phone as a peer",
      detail:
        "Create a peer config, then show it as a QR code with qrencode -t ansiutf8 and scan it in the WireGuard app.",
    },
    {
      title: "Test from outside",
      detail:
        "Turn off Wi-Fi, connect the tunnel, and open a local address such as your NAS dashboard.",
    },
  ],
};

export const ebikeClarify: CatalogProps<"ChoiceChips"> = {
  prompt: "What matters most to you?",
  multi: true,
  submitLabel: "Continue",
  choices: [
    { id: "range", label: "Range" },
    { id: "hills", label: "Hill climbing" },
    { id: "weight", label: "Light enough to carry" },
    { id: "cargo", label: "Carrying groceries" },
    { id: "repair", label: "Easy to repair" },
  ],
};

export const ebikePlan: CatalogProps<"ResearchPlan"> = {
  question: "Best e-bikes under $2,000 for city commuting",
  depth: 2,
  budgetUsd: 0.6,
  steps: [
    {
      id: "s1",
      title: "Shortlist models under $2,000 sold in Canada",
      queries: ["best commuter ebike under 2000 2026", "ebike canada price list"],
    },
    {
      id: "s2",
      title: "Compare real-world range and hill performance",
      queries: ["ebike range test hills", "mid-drive vs hub motor climbing"],
    },
    {
      id: "s3",
      title: "Check weight, cargo racks and servicing",
      queries: ["ebike weight under 25kg commuter", "ebike repairability parts availability"],
    },
    {
      id: "s4",
      title: "Read owner reports on reliability",
      queries: ["reddit ebikes long term review", "ebike warranty claims"],
    },
  ],
};

export const ebikeProgress: CatalogProps<"ResearchProgress"> = {
  live: true,
  durationMs: 9000,
  sourcesFound: 38,
  sourcesKept: 11,
  workers: [
    { id: "w1", label: "Shortlist", sources: 9 },
    { id: "w2", label: "Range and hills", sources: 11 },
    { id: "w3", label: "Weight and servicing", sources: 8 },
    { id: "w4", label: "Owner reports", sources: 10 },
  ],
};

export const ebikeTable: CatalogProps<"Table"> = {
  title: "Shortlist",
  columns: [
    { key: "model", label: "Model" },
    { key: "price", label: "Price", numeric: true },
    { key: "range", label: "Range", numeric: true },
    { key: "weight", label: "Weight", numeric: true },
    { key: "motor", label: "Motor" },
  ],
  rows: [
    {
      model: "Aventon Level 3",
      price: "$1,899",
      range: "96 km",
      weight: "29 kg",
      motor: "Rear hub, torque sensor",
    },
    {
      model: "Velotric Discover 2",
      price: "$1,599",
      range: "105 km",
      weight: "30 kg",
      motor: "Rear hub",
    },
    {
      model: "Ride1Up Prodigy V2",
      price: "$1,995",
      range: "80 km",
      weight: "23 kg",
      motor: "Mid-drive",
    },
    {
      model: "Lectric XP Trike",
      price: "$1,499",
      range: "72 km",
      weight: "35 kg",
      motor: "Front hub",
    },
  ],
  caption:
    "Prices in CAD where available. Range is the manufacturer's claim; tested range ran 20–35% lower.",
};

export const ebikeSources: Source[] = [
  src(
    "https://electricbikereview.com/category/commuter",
    "Commuter e-bike reviews",
    "Hands-on reviews with range and hill tests.",
    "subagent"
  ),
  src(
    "https://www.bicycling.com/bikes-gear/g26529536/best-cheap-electric-bikes",
    "Best cheap electric bikes",
    "Picks under $2,000 with ride notes.",
    "subagent"
  ),
  src(
    "https://www.outsideonline.com/outdoor-gear/bikes-and-biking/best-commuter-ebikes",
    "Best commuter e-bikes",
    "Seasonal test of city e-bikes.",
    "subagent"
  ),
  src(
    "https://www.reddit.com/r/ebikes/comments/long_term_owner",
    "Two years with a budget e-bike",
    "Owner thread on reliability and parts.",
    "subagent"
  ),
  src(
    "https://www.ride1up.com/product/prodigy-v2",
    "Ride1Up Prodigy V2 specs",
    "Mid-drive Brose motor, 23 kg.",
    "subagent"
  ),
  src(
    "https://www.aventon.com/products/level-3",
    "Aventon Level 3",
    "Torque sensor, integrated rack, UL certified.",
    "subagent"
  ),
  src(
    "https://www.velotricbike.com/products/discover-2",
    "Velotric Discover 2",
    "Claimed 105 km range, 48V battery.",
    "subagent"
  ),
  src(
    "https://www.cyclingweekly.com/group-tests/hub-vs-mid-drive",
    "Hub vs mid-drive motors",
    "Why mid-drives climb better on steep grades.",
    "subagent"
  ),
  src(
    "https://www.consumerreports.org/electric-bikes/ebike-battery-safety",
    "E-bike battery safety",
    "Why UL 2849 certification matters.",
    "subagent"
  ),
  src(
    "https://ebikeschool.com/repairability",
    "Repairable e-bikes",
    "Standard parts and service networks compared.",
    "subagent"
  ),
  src(
    "https://www.cbc.ca/news/canada/toronto/ebike-rules",
    "E-bike rules in Toronto",
    "Speed and weight limits for power-assisted bicycles.",
    "subagent"
  ),
];

export const phonePlan: CatalogProps<"SubagentPlan"> = {
  goal: "Compare Pixel 11 and iPhone 17 for camera, battery and value",
  costEstimateUsd: 0.08,
  budget: { maxTokens: 60_000, maxSearches: 12, maxMinutes: 3 },
  tasks: [
    {
      id: "t1",
      role: "search",
      brief: "Camera reviews and sample comparisons",
      model: "GPT-5 mini",
      estTokens: 14_000,
    },
    {
      id: "t2",
      role: "search",
      brief: "Battery tests and charging speeds",
      model: "GPT-5 mini",
      estTokens: 12_000,
    },
    {
      id: "t3",
      role: "reader",
      brief: "Prices, trade-in offers and update policy",
      model: "GPT-5 mini",
      estTokens: 10_000,
    },
    {
      id: "t4",
      role: "verifier",
      brief: "Check every claim against the sources",
      model: "Claude Sonnet 4.5",
      estTokens: 9_000,
    },
  ],
};

export const phoneTimeline: CatalogProps<"SubagentTimeline"> = {
  live: true,
  runs: [
    {
      id: "t1",
      role: "search",
      brief: "Camera reviews and sample comparisons",
      model: "GPT-5 mini",
      durationMs: 4200,
      sourcesRead: 7,
      tokens: 12_840,
      outcome: "done",
      result:
        "Pixel leads in low light and zoom past 5×; iPhone has more natural skin tones and better video stabilisation.",
    },
    {
      id: "t2",
      role: "search",
      brief: "Battery tests and charging speeds",
      model: "GPT-5 mini",
      durationMs: 5600,
      sourcesRead: 5,
      tokens: 10_220,
      outcome: "done",
      result:
        "iPhone lasts about 1.5 h longer in mixed-use tests. Pixel charges faster: 50% in 23 min vs 30 min.",
    },
    {
      id: "t3",
      role: "reader",
      brief: "Prices, trade-in offers and update policy",
      model: "GPT-5 mini",
      durationMs: 3600,
      sourcesRead: 4,
      tokens: 8_310,
      outcome: "failed",
      result: "Carrier pages blocked the fetch. Used manufacturer list prices only.",
    },
    {
      id: "t4",
      role: "verifier",
      brief: "Check every claim against the sources",
      model: "Claude Sonnet 4.5",
      durationMs: 7000,
      sourcesRead: 16,
      tokens: 7_960,
      outcome: "done",
      result: "15 of 16 claims verified. Dropped one battery figure that no source supported.",
    },
  ],
};

export const phoneCompare: CatalogProps<"Compare"> = {
  title: "Pixel 11 vs iPhone 17",
  items: [
    { id: "pixel", name: "Pixel 11", subtitle: "From $799" },
    { id: "iphone", name: "iPhone 17", subtitle: "From $829" },
  ],
  rows: [
    { label: "Low-light photos", values: ["Cleaner, brighter", "More natural"], winner: 0 },
    { label: "Video", values: ["Good", "Best in class"], winner: 1 },
    { label: "Battery, mixed use", values: ["9 h 40 min", "11 h 10 min"], winner: 1 },
    { label: "Charging to 50%", values: ["23 min", "30 min"], winner: 0 },
    { label: "Updates", values: ["7 years", "6+ years"] },
  ],
  verdict: "Pick Pixel for photos and faster charging; iPhone for video and battery.",
};

export const phoneSources: Source[] = [
  src(
    "https://www.gsmarena.com/pixel_11-review",
    "Pixel 11 review",
    "Camera, display and battery tests.",
    "subagent"
  ),
  src(
    "https://www.dxomark.com/smartphones/camera-ranking",
    "Camera ranking",
    "Lab scores for photo and video.",
    "subagent"
  ),
  src(
    "https://www.tomsguide.com/phones/battery-life-test",
    "Smartphone battery life test",
    "Web-surfing test over 5G at 150 nits.",
    "subagent"
  ),
  src(
    "https://www.apple.com/iphone-17/specs",
    "iPhone 17 technical specifications",
    "Official specs and pricing.",
    "subagent"
  ),
  src(
    "https://store.google.com/product/pixel_11",
    "Pixel 11 on Google Store",
    "Official specs and pricing.",
    "subagent"
  ),
];
