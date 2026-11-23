import { useCallback, useEffect, useState } from "react";
import { Link, XmrLogo } from "./components/ui";
import { SessionProvider } from "./lib/SessionProvider";
import { useSession } from "./lib/session";
import Account from "./pages/Account";
import Heritage from "./pages/Heritage";
import Home from "./pages/Home";
import Login from "./pages/Login";
import Open from "./pages/Open";
import Pay from "./pages/Pay";
import Start from "./pages/Start";
import Terms from "./pages/Terms";
import Trust from "./pages/Trust";
import Vault from "./pages/Vault";

function useRoute(): string {
  const [route, setRoute] = useState(() => location.hash.slice(1).split("?")[0] || "/");
  useEffect(() => {
    const on = () => {
      setRoute(location.hash.slice(1).split("?")[0] || "/");
      window.scrollTo(0, 0);
    };
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
}

function Page({ route }: { route: string }) {
  const parts = route.split("/").filter(Boolean);
  switch (parts[0]) {
    case undefined:
      return <Home />;
    case "start":
      return <Start />;
    case "login":
      return <Login />;
    case "account":
      return <Account />;
    case "vault":
      return <Vault />;
    case "heritage":
      return <Heritage />;
    case "pay":
      return parts[1] ? <Pay id={BigInt(parts[1])} /> : <Account />;
    case "open":
      return parts[1] && parts[2] ? <Open id={BigInt(parts[1])} secret={parts[2]} /> : <Home />;
    case "trust":
      return <Trust />;
    case "terms":
      return <Terms />;
    default:
      return <Home />;
  }
}

function Shell() {
  const route = useRoute();
  const { account } = useSession();
  const heirPage = route.startsWith("/open/");
  return (
    <>
      <header className="top">
        <div className="in">
          <Link to="/" className="brand">
            <img src="/logo-xmr.svg" alt="" /> Ashkey
          </Link>
          {!heirPage && (
            <nav className="nav">
              <a href="#/" onClick={() => setTimeout(() => document.getElementById("pricing")?.scrollIntoView(), 50)} className="hide-sm">
                Pricing
              </a>
              <Link to="/trust" className="hide-sm">Verify</Link>
              {account ? (
                <>
                  <Link to="/vault">Vault</Link>
                  <Link to="/heritage">Heritage</Link>
                  <Link to="/account" className="btn small">Account</Link>
                </>
              ) : (
                <>
                  <Link to="/login">Sign in</Link>
                  <Link to="/start" className="btn small primary">Get started</Link>
                </>
              )}
            </nav>
          )}
        </div>
      </header>
      <main>
        <Page route={route} />
      </main>
      <footer className="foot">
        <div className="in">
          <span>
            <span className="xmr-badge">
              <XmrLogo size={16} /> Monero accepted, and only Monero
            </span>
            <br />
            Ashkey · encrypted vault & heritage switch · runs on the Internet Computer

          </span>
          <span className="row">
            <Link to="/trust">Verify</Link>
            <Link to="/terms">Terms</Link>
            <a href="https://github.com/icpbuilder01/ashkey" target="_blank" rel="noopener noreferrer">Source</a>
          </span>
        </div>
      </footer>
    </>
  );
}

export default function App() {
  const [toast, setToast] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  const show = useCallback((text: string, kind: "ok" | "err" = "ok") => {
    setToast({ text, kind });
    setTimeout(() => setToast(null), 5000);
  }, []);
  return (
    <SessionProvider toast={show}>
      <Shell />
      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
    </SessionProvider>
  );
}
