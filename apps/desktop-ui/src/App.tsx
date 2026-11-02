import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { AuthGate, AuthProvider, HomeRedirect, useAuth, type AuthState } from "./auth";
import { AccountIcon } from "./components/AccountIcon";
import { AccountPage } from "./pages/AccountPage";
import { AiPage } from "./pages/AiPage";
import { BuilderPage } from "./pages/BuilderPage";
import { HardwarePage } from "./pages/HardwarePage";
import { NodePage } from "./pages/NodePage";
import { OverviewPage } from "./pages/OverviewPage";
import { PairPage } from "./pages/PairPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SmartHomePage } from "./pages/SmartHomePage";

const links = [
  ["/", "Overview"],
  ["/setup", "Setup"],
  ["/smart-home", "Smart Home Connection"],
  ["/pair", "Pair New Node"],
  ["/builder", "Firmware Builder"],
  ["/ai", "AI-Assisted Development"],
  ["/settings", "Settings"],
] as const;

export function App({ initial }: { initial?: AuthState } = {}) {
  return (
    <AuthProvider initial={initial}>
      <AuthGate>
        <Shell />
      </AuthGate>
    </AuthProvider>
  );
}

function Shell() {
  const auth = useAuth();
  const visible = auth.user?.role === "administrator" ? links : [];
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <strong>IoT.Edu</strong>
          <span>Node management</span>
        </div>
        <nav aria-label="Primary">
          {visible.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === "/"}>
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-end">
          <nav aria-label="Account">
            <NavLink to="/account" className={({ isActive }) => `account-link${isActive ? " active" : ""}`}>
              <AccountIcon />
              <span>
                Account
                {auth.user?.displayName ? <small>{auth.user.displayName}</small> : null}
              </span>
            </NavLink>
          </nav>
          <footer>Management fabric only. Sensor readings stay in the smart-home app.</footer>
        </div>
      </aside>
      <main className="main">
        <Routes>
          {auth.user?.role === "administrator" ? (
            <>
              <Route path="/" element={<OverviewPage />} />
              <Route path="/setup" element={<HardwarePage />} />
              <Route path="/verify" element={<Navigate to="/setup" replace />} />
              <Route path="/smart-home" element={<SmartHomePage />} />
              <Route path="/pair" element={<PairPage />} />
              <Route path="/nodes/:id" element={<NodePage />} />
              <Route path="/library" element={<Navigate to="/builder?section=components" replace />} />
              <Route path="/builder" element={<BuilderPage />} />
              <Route path="/ai" element={<AiPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/account" element={<AccountPage />} />
              <Route path="/login" element={<HomeRedirect />} />
              <Route path="/register" element={<HomeRedirect />} />
            </>
          ) : (
            <>
              <Route path="/account" element={<AccountPage />} />
              <Route path="*" element={<Navigate to="/account" replace />} />
            </>
          )}
        </Routes>
      </main>
    </div>
  );
}
