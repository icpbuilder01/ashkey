import { createContext, useContext } from "react";
import type { AccountView, Info } from "../bindings/ashkey/ashkey";
import type { AccountKeys } from "./account";
import type { Api } from "./env";

export interface Session {
  info: Info | null;
  account: AccountKeys | null;
  me: AccountView | null;
  api: Api; // anonymous when signed out
  /** Signs in and returns the signed actor. Also checks in heritage switches. */
  signIn: (number: string, persistent: boolean) => Promise<Api>;
  signOut: () => void;
  refresh: () => Promise<void>;
  toast: (text: string, kind?: "ok" | "err") => void;
}

export const Ctx = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error("no session");
  return s;
}

