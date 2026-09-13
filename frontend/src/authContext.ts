import { createContext, useContext } from "react";
import type { AuthStatus } from "./api/index.js";

export const AuthStatusContext = createContext<AuthStatus | null>(null);

export function useAuthStatus(): AuthStatus | null {
  return useContext(AuthStatusContext);
}
