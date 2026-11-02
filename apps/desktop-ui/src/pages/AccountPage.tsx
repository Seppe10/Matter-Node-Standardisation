import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, api } from "../api";
import { useAuth } from "../auth";
import {
  confirmationError,
  displayNameError,
  passwordError,
  registerFieldError,
  type ListedUser,
} from "../auth-form";
import { formatLocalDateTime, MISSING_TIMESTAMP } from "../datetime";
import { SecretField } from "../components/SecretField";

function failure(reason: unknown): string {
  return reason instanceof ApiError ? reason.message : "Unable to connect. Please try again.";
}

function roleLabel(role: ListedUser["role"]): string {
  return role === "administrator" ? "Administrator" : "User";
}

export function AccountPage() {
  const auth = useAuth();
  const user = auth.user;
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileNotice, setProfileNotice] = useState<string | null>(null);
  const [profilePending, setProfilePending] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordErrorMessage, setPasswordErrorMessage] = useState<string | null>(null);
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null);
  const [passwordPending, setPasswordPending] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [people, setPeople] = useState<ListedUser[]>([]);
  const [selfRegistration, setSelfRegistration] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [adminNotice, setAdminNotice] = useState<string | null>(null);
  const profileRef = useRef(false);
  const passwordRef = useRef(false);

  useEffect(() => {
    setDisplayName(user?.displayName ?? "");
  }, [user?.displayName]);

  useEffect(() => {
    if (user?.role !== "administrator" || user.local) return;
    let live = true;
    void Promise.all([
      api<{ users: ListedUser[] }>("/api/users"),
      api<{ selfRegistration: boolean }>("/api/auth/policy"),
    ]).then(([listed, policy]) => {
      if (!live) return;
      setPeople(listed.users);
      setSelfRegistration(policy.selfRegistration);
    }).catch((reason: unknown) => {
      if (live) setAdminError(failure(reason));
    });
    return () => {
      live = false;
    };
  }, [user?.role]);

  if (!user) return null;
  if (user.local) return <LocalAccount />;

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    if (profileRef.current) return;
    const message = displayNameError(displayName);
    if (message) {
      setProfileError(message);
      return;
    }
    profileRef.current = true;
    setProfilePending(true);
    setProfileError(null);
    setProfileNotice(null);
    try {
      await auth.updateProfile(displayName.trim());
      setProfileNotice("Display name updated.");
    } catch (reason) {
      setProfileError(failure(reason));
    } finally {
      profileRef.current = false;
      setProfilePending(false);
    }
  }

  async function savePassword(event: FormEvent) {
    event.preventDefault();
    if (passwordRef.current) return;
    const next = passwordError(newPassword, user?.email ?? "");
    const message = currentPassword.length === 0
      ? "Enter your current password."
      : next === "Enter your password."
        ? "Enter a new password."
        : next ?? confirmationError(newPassword, confirmPassword);
    if (message) {
      setPasswordErrorMessage(message);
      return;
    }
    passwordRef.current = true;
    setPasswordPending(true);
    setPasswordErrorMessage(null);
    setPasswordNotice(null);
    try {
      await api("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordNotice("Password updated.");
    } catch (reason) {
      setPasswordErrorMessage(failure(reason));
    } finally {
      passwordRef.current = false;
      setPasswordPending(false);
    }
  }

  async function logout() {
    setLogoutError(null);
    try {
      await auth.logout();
    } catch (reason) {
      setLogoutError(failure(reason));
    }
  }

  async function refreshPeople() {
    const listed = await api<{ users: ListedUser[] }>("/api/users");
    setPeople(listed.users);
  }

  return (
    <section className="stack">
      <header className="page-head">
        <div>
          <h1>Account</h1>
          <p className="lede">Your sign-in details for this IoT.Edu installation.</p>
        </div>
      </header>
      <div className="account-grid">
        <form className="panel stack" onSubmit={(event) => void saveProfile(event)}>
          <h2>Profile</h2>
          {profileError && <p className="form-error" role="alert">{profileError}</p>}
          {profileNotice && <p className="banner">{profileNotice}</p>}
          <label>
            Display name
            <input value={displayName} maxLength={80} autoComplete="name" disabled={profilePending} onChange={(event) => setDisplayName(event.target.value)} />
          </label>
          <label>
            Email address
            <input value={user.email} readOnly aria-readonly="true" />
          </label>
          <p className="muted">Email address changes are not available.</p>
          <dl className="facts">
            <div><dt>Role</dt><dd>{roleLabel(user.role)}</dd></div>
            <div><dt>Created</dt><dd>{formatLocalDateTime(user.createdAt)}</dd></div>
            <div><dt>Last login</dt><dd>{user.lastLoginAt ? formatLocalDateTime(user.lastLoginAt) : MISSING_TIMESTAMP}</dd></div>
          </dl>
          <button type="submit" disabled={profilePending}>{profilePending ? "Saving…" : "Save display name"}</button>
        </form>
        <form className="panel stack" onSubmit={(event) => void savePassword(event)}>
          <h2>Security</h2>
          {passwordErrorMessage && <p className="form-error" role="alert">{passwordErrorMessage}</p>}
          {passwordNotice && <p className="banner">{passwordNotice}</p>}
          <SecretField label="Current password" value={currentPassword} autoComplete="current-password" disabled={passwordPending} onChange={setCurrentPassword} />
          <SecretField label="New password" value={newPassword} autoComplete="new-password" disabled={passwordPending} onChange={setNewPassword} />
          <SecretField label="Confirm new password" value={confirmPassword} autoComplete="new-password" disabled={passwordPending} onChange={setConfirmPassword} />
          <p className="muted">Use at least 12 characters. A passphrase is fine.</p>
          <button type="submit" disabled={passwordPending}>{passwordPending ? "Updating…" : "Change password"}</button>
          {logoutError && <p className="form-error" role="alert">{logoutError}</p>}
          <button type="button" className="secondary" onClick={() => void logout()}>Log out</button>
        </form>
      </div>
      {user.role === "administrator" ? (
        <AdminPeople
          people={people}
          selfRegistration={selfRegistration}
          error={adminError}
          notice={adminNotice}
          onError={setAdminError}
          onNotice={setAdminNotice}
          onSelfRegistration={setSelfRegistration}
          onChanged={refreshPeople}
        />
      ) : null}
    </section>
  );
}

function AdminPeople({
  people,
  selfRegistration,
  error,
  notice,
  onError,
  onNotice,
  onSelfRegistration,
  onChanged,
}: {
  people: ListedUser[];
  selfRegistration: boolean;
  error: string | null;
  notice: string | null;
  onError: (value: string | null) => void;
  onNotice: (value: string | null) => void;
  onSelfRegistration: (value: boolean) => void;
  onChanged: () => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [role, setRole] = useState<"administrator" | "user">("user");
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);

  async function createAccount(event: FormEvent) {
    event.preventDefault();
    if (pendingRef.current) return;
    const message = registerFieldError({ displayName, email, password, confirmPassword });
    if (message) {
      onError(message);
      return;
    }
    pendingRef.current = true;
    setPending(true);
    onError(null);
    onNotice(null);
    try {
      await api("/api/users", {
        method: "POST",
        body: JSON.stringify({ displayName: displayName.trim(), email: email.trim(), password, confirmPassword, role }),
      });
      setDisplayName("");
      setEmail("");
      setPassword("");
      setConfirmPassword("");
      setRole("user");
      onNotice("Account created.");
      await onChanged();
    } catch (reason) {
      onError(failure(reason));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  async function run(action: () => Promise<void>, success: string) {
    onError(null);
    onNotice(null);
    try {
      await action();
      onNotice(success);
      await onChanged();
    } catch (reason) {
      onError(failure(reason));
    }
  }

  return (
    <section className="panel stack">
      <h2>People</h2>
      {error && <p className="form-error" role="alert">{error}</p>}
      {notice && <p className="banner">{notice}</p>}
      <button
        type="button"
        className="secondary"
        onClick={() => void run(async () => {
          const body = await api<{ selfRegistration: boolean }>("/api/auth/policy", {
            method: "PATCH",
            body: JSON.stringify({ selfRegistration: !selfRegistration }),
          });
          onSelfRegistration(body.selfRegistration);
        }, selfRegistration ? "Self-registration is closed." : "Self-registration is open.")}
      >
        {selfRegistration ? "Close self-registration" : "Allow self-registration"}
      </button>
      <form className="stack" onSubmit={(event) => void createAccount(event)}>
        <h3>Create an account</h3>
        <label>
          Display name
          <input value={displayName} maxLength={80} disabled={pending} onChange={(event) => setDisplayName(event.target.value)} />
        </label>
        <label>
          Email address
          <input type="email" value={email} maxLength={254} spellCheck={false} disabled={pending} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <SecretField label="Password" value={password} autoComplete="new-password" disabled={pending} onChange={setPassword} />
        <SecretField label="Confirm password" value={confirmPassword} autoComplete="new-password" disabled={pending} onChange={setConfirmPassword} />
        <label>
          Role
          <select value={role} disabled={pending} onChange={(event) => setRole(event.target.value === "administrator" ? "administrator" : "user")}>
            <option value="user">User</option>
            <option value="administrator">Administrator</option>
          </select>
        </label>
        <button type="submit" disabled={pending}>{pending ? "Creating…" : "Create account"}</button>
      </form>
      <div className="table-scroll">
        <table>
          <thead>
            <tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {people.map((person) => (
              <tr key={person.email}>
                <td>{person.displayName}</td>
                <td>{person.email}</td>
                <td>{roleLabel(person.role)}</td>
                <td>{person.status === "active" ? "Active" : "Disabled"}</td>
                <td>
                  <div className="row">
                    <button type="button" className="secondary" onClick={() => void run(() => api("/api/users", {
                      method: "PATCH",
                      body: JSON.stringify({ email: person.email, role: person.role === "administrator" ? "user" : "administrator" }),
                    }), "Role updated.")}>
                      {person.role === "administrator" ? "Make user" : "Make administrator"}
                    </button>
                    <button type="button" className="secondary" onClick={() => void run(() => api("/api/users", {
                      method: "PATCH",
                      body: JSON.stringify({ email: person.email, status: person.status === "active" ? "disabled" : "active" }),
                    }), person.status === "active" ? "Account disabled." : "Account enabled.")}>
                      {person.status === "active" ? "Disable" : "Enable"}
                    </button>
                    <button type="button" className="secondary" onClick={() => void run(() => api("/api/users/revoke-sessions", {
                      method: "POST",
                      body: JSON.stringify({ email: person.email }),
                    }), "Sessions revoked.")}>
                      Revoke sessions
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function LocalAccount() {
  return (
    <section className="stack">
      <header className="page-head">
        <div>
          <h1>Account</h1>
          <p className="lede">IoT.Edu is running in local mode.</p>
        </div>
      </header>
      <div className="panel stack">
        <h2>No sign-in needed</h2>
        <p>No database is connected, so there are no accounts. Anyone using this computer can use IoT.Edu, as with any desktop app. Other computers cannot reach it.</p>
        <p>To add accounts, connect a PostgreSQL database: set <code>DATABASE_URL</code> in <code>apps/local-api/.env</code>, run <code>npm run db:setup</code>, then restart IoT.Edu. The first account you create becomes the administrator.</p>
      </div>
    </section>
  );
}
