import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { AccountView, Info } from "../bindings/ashkey/ashkey";
import { deriveAccount, forget, parseAccountNumber, remember, rememberedNumber, type AccountKeys } from "./account";
import { getActor, type Api } from "./env";
import { Ctx, type Session } from "./session";

export function SessionProvider({ children, toast }: { children: ReactNode; toast: Session["toast"] }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [account, setAccount] = useState<AccountKeys | null>(null);
  const [me, setMe] = useState<AccountView | null>(null);
  const [api, setApi] = useState<Api>(() => getActor());

  useEffect(() => {
    getActor().get_info().then(setInfo).catch(() => toast("The service is not reachable right now.", "err"));
  }, [toast]);

  const load = useCallback(async (a: Api) => setMe(await a.me()), []);

  const signIn = useCallback(
    async (number: string, persistent: boolean) => {
      const { raw, text } = await parseAccountNumber(number);
      const keys = await deriveAccount(raw, text);
      const a = getActor(keys.identity);
      const view = await a.me();
      setMe(view);
      remember(text, persistent);
      setAccount(keys);
      setApi(() => a);
      // Signing in counts as "still here" for heritage switches.
      if (view.heritage_until > 0n) a.check_in().catch(() => undefined);
      return a;
    },
    []
  );

  useEffect(() => {
    const n = rememberedNumber();
    if (n) Promise.resolve().then(() => signIn(n, localStorage.getItem("ashkey.account") !== null)).catch(() => forget());
  }, [signIn]);

  const signOut = useCallback(() => {
    forget();
    setAccount(null);
    setMe(null);
    setApi(() => getActor());
  }, []);

  const refresh = useCallback(async () => {
    if (account) await load(api);
  }, [account, api, load]);

  return <Ctx.Provider value={{ info, account, me, api, signIn, signOut, refresh, toast }}>{children}</Ctx.Provider>;
}
