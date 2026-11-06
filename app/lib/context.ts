import { createContext } from "react-router";
import type { WebEnv } from "../../workers/web/env";

export const webEnvContext = createContext<{ env: WebEnv; ctx: ExecutionContext }>();
