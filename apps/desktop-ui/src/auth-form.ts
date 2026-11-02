const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const COMMON_PASSWORDS = new Set([
  "123456789012",
  "1234567890123",
  "123123123123",
  "000000000000",
  "111111111111",
  "1qaz2wsx3edc",
  "1q2w3e4r5t6y",
  "abcdefghijkl",
  "abcdefg12345",
  "access123456",
  "adminadmin12",
  "adminadminadmin",
  "andrew123456",
  "asdfghjkl123",
  "ashley123456",
  "baseball1234",
  "batman123456",
  "buster123456",
  "changeme1234",
  "computer1234",
  "correcthorsebatterystaple",
  "dragon123456",
  "football1234",
  "freedom12345",
  "george123456",
  "hockey123456",
  "hunter123456",
  "iloveyou1234",
  "iloveyou12345",
  "internet1234",
  "jessica12345",
  "jordan123456",
  "letmeinletmein",
  "letmeinplease",
  "master123456",
  "michael12345",
  "michelle1234",
  "p@ssw0rd1234",
  "pa$$w0rd1234",
  "passw0rd1234",
  "passw0rdpass",
  "password password",
  "password!234",
  "password1234",
  "password12345",
  "passwordpassword",
  "pepper123456",
  "princess1234",
  "qwerty123456",
  "qwertyqwerty",
  "qwertyuiop12",
  "qwertyuiopas",
  "ranger123456",
  "secret123456",
  "shadow123456",
  "soccer123456",
  "starwars1234",
  "summer123456",
  "sunshine1234",
  "superman1234",
  "thomas123456",
  "trustno1trust",
  "welcome12345",
  "whatever1234",
  "winter123456",
  "zxcvbnm12345",
]);

export interface PublicUser {
  displayName: string;
  email: string;
  role: "administrator" | "user";
  createdAt: string;
  lastLoginAt: string | null;
  /** True in local mode (no database): a built-in single user, no sign-in. */
  local?: boolean;
}

export interface ListedUser extends PublicUser {
  status: "active" | "disabled";
}

export function nextPathAfterLogin(from: unknown): string {
  if (typeof from !== "string") return "/";
  if (!from.startsWith("/") || from.startsWith("//") || from.startsWith("/\\")) return "/";
  if (from.startsWith("/login") || from.startsWith("/register")) return "/";
  return from;
}

export function emailError(value: string): string | null {
  if (value.trim() === "") return "Enter your email address.";
  if (value.trim().length > 254 || !EMAIL.test(value.trim())) return "Enter a valid email address.";
  return null;
}

export function displayNameError(value: string): string | null {
  if (value.trim() === "") return "Enter a display name.";
  if (value.trim().length > 80) return "Use a shorter display name.";
  return null;
}

export function passwordError(password: string, email = ""): string | null {
  if (password.length === 0) return "Enter your password.";
  if (password.length < 12) return "Use at least 12 characters.";
  if (password.length > 128) return "Use at most 128 characters.";
  const folded = password.toLowerCase();
  if (COMMON_PASSWORDS.has(folded) || /^(.)\1+$/u.test(password)) return "Choose a password that is not commonly used.";
  const normalized = email.trim().toLowerCase();
  const local = normalized.split("@")[0] ?? "";
  if ((normalized.length > 0 && folded === normalized) || (local.length >= 12 && folded === local)) {
    return "Choose a password that does not match your email address.";
  }
  return null;
}

export function confirmationError(password: string, confirm: string): string | null {
  if (confirm.length === 0) return "Confirm your password.";
  if (confirm !== password) return "Passwords do not match.";
  return null;
}

export function loginFieldError(email: string, password: string): string | null {
  return emailError(email) ?? (password.length === 0 ? "Enter your password." : password.length > 128 ? "Invalid email or password." : null);
}

export function registerFieldError(input: { displayName: string; email: string; password: string; confirmPassword: string }): string | null {
  return displayNameError(input.displayName)
    ?? emailError(input.email)
    ?? passwordError(input.password, input.email)
    ?? confirmationError(input.password, input.confirmPassword);
}
