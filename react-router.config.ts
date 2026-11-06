import type { Config } from "@react-router/dev/config";

export default {
  // Public pages are server-rendered so they are useful and indexable before hydration.
  ssr: true,
} satisfies Config;
