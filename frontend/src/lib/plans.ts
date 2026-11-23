import type { OrderView, Product } from "../bindings/ashkey/ashkey";
import { bytes } from "./format";

export type Choice = "v1" | "v2" | "v3" | "h";

export function productOf(c: Choice): Product {
  return c === "h" ? { __kind__: "Heritage", Heritage: null } : { __kind__: "Vault", Vault: Number(c[1]) };
}

export function productName(o: OrderView, tierBytes?: ArrayLike<bigint>): string {
  if (o.product.__kind__ === "Heritage") return "Heritage switch";
  const t = o.product.Vault;
  return `Vault ${tierBytes ? bytes(tierBytes[t - 1]) : `tier ${t}`}`;
}

export function heirLink(id: bigint, s: string): string {
  return `${location.origin}/#/open/${id}/${s}`;
}
