type Res<T> = { __kind__: "Ok"; Ok: T } | { __kind__: "Err"; Err: string };

/** Unwraps a canister result: the Ok value, or throws the error text. */
export function ok<T>(r: Res<T>): T {
  if (r.__kind__ === "Err") throw new Error(r.Err);
  return r.Ok;
}
