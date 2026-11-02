import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { LibraryComponent, LibraryValidationResponse } from "@iotedu/contracts";
import { ApiError, api } from "../api";
import {
  addGpioRow,
  addLibraryFiles,
  blankLibraryForm,
  canSaveLibrary,
  duplicateLibraryName,
  libraryFormFromComponent,
  librarySaveRequirement,
  libraryUploadPath,
  localLibraryIssues,
  removeGpioRow,
  removeNewFile,
  removeRetainedFile,
  saveLibraryLabel,
  scrollBuilderForm,
  updateGpioRow,
  withLibraryChange,
  type LibraryFormState,
} from "../firmware-library-form";
import { FirmwareLibrarySection, type PendingImport } from "./CatalogPage";

function issueDetail(issue: { message: string; file?: string; line?: number }): string {
  const place = issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ""}: ` : "";
  return `${place}${issue.message}`;
}

function libraryLoadMessage(reason: unknown): string {
  if (reason instanceof ApiError && reason.code === "route_not_found") {
    return "The firmware library API is not available. Refresh this page after the local API is running. You can still prepare a new component.";
  }
  if (reason instanceof TypeError) {
    return "The local API is not reachable. Start it, then refresh this page. You can still prepare a new component.";
  }
  if (reason instanceof ApiError && reason.code === "catalogue_unavailable") {
    return `${reason.message} The catalogue was not reported as empty.`;
  }
  if (reason instanceof ApiError && (reason.status === 404 || reason.message === "Request failed (404)")) {
    return "The firmware library API route was not found. This is not an empty catalogue. Refresh this page after the local API is running.";
  }
  if (reason instanceof ApiError) return reason.message;
  return "The firmware library could not be loaded.";
}

function fileFromEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readDirectory(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function filesInside(entry: FileSystemDirectoryEntry, prefix: string): Promise<{ file: File; path: string }[]> {
  const reader = entry.createReader();
  const children: FileSystemEntry[] = [];
  while (true) {
    const batch = await readDirectory(reader);
    if (batch.length === 0) break;
    children.push(...batch);
  }
  const collected: { file: File; path: string }[] = [];
  for (const child of children) {
    if (child.isFile) {
      const file = await fileFromEntry(child as FileSystemFileEntry);
      collected.push({ file, path: prefix ? `${prefix}/${child.name}` : child.name });
    } else if (child.isDirectory) {
      const next = prefix ? `${prefix}/${child.name}` : child.name;
      collected.push(...await filesInside(child as FileSystemDirectoryEntry, next));
    }
  }
  return collected;
}

async function encodeFile(file: File, name: string): Promise<{ name: string; contentBase64: string }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }
  return { name, contentBase64: btoa(binary) };
}

export function BuilderPage() {
  const [params] = useSearchParams();
  const [components, setComponents] = useState<LibraryComponent[]>([]);
  const [pending, setPending] = useState<PendingImport[]>([]);
  const [form, setForm] = useState<LibraryFormState>(blankLibraryForm);
  const [phase, setPhase] = useState<"idle" | "validating" | "saving">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localIssues, setLocalIssues] = useState<string[]>([]);
  const [uploadChoices, setUploadChoices] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const ticket = useRef(0);

  useEffect(() => {
    let active = true;
    api<{ components: LibraryComponent[]; pending?: PendingImport[] }>("/api/firmware-library")
      .then((body) => {
        if (!active) return;
        const components = body.components ?? [];
        setComponents(components);
        setPending(body.pending ?? []);
        setForm((current) => {
          if (current.selectionId && !components.some((item) => item.id === current.selectionId)) return blankLibraryForm();
          return current;
        });
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setComponents([]);
        setPending([]);
        setForm(blankLibraryForm());
        setError(libraryLoadMessage(reason));
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const section = params.get("section");
    if (section) document.getElementById(section)?.scrollIntoView();
  }, [params]);

  function replaceForm(next: LibraryFormState) {
    ticket.current += 1;
    setForm(next);
    setLocalIssues([]);
    setError(null);
  }

  function patch(partial: Partial<LibraryFormState>) {
    ticket.current += 1;
    setForm((current) => withLibraryChange(current, partial));
    setLocalIssues([]);
    setMessage(null);
  }

  function edit(component: LibraryComponent) {
    if (component.provenance !== "custom") return;
    replaceForm(libraryFormFromComponent(component));
    setMessage(null);
    scrollBuilderForm(document.getElementById("build-firmware"));
  }

  async function editPending(id: string) {
    setMessage(null);
    try {
      const body = await api<{ component: LibraryComponent }>(`/api/firmware-library/${id}`);
      edit(body.component);
    } catch (reason) {
      setMessage(reason instanceof ApiError ? reason.message : "The catalogue component could not be opened.");
    }
  }

  async function validate() {
    const issues = localLibraryIssues(form);
    const duplicate = duplicateLibraryName(form, components);
    const blocked = duplicate ? [...issues, duplicate] : issues;
    if (blocked.length > 0 || (form.type !== "sensor" && form.type !== "actuator")) {
      setLocalIssues(blocked.length > 0 ? blocked : ["Component Type is required."]);
      ticket.current += 1;
      setForm((current) => ({ ...current, validation: null }));
      return;
    }
    const currentTicket = ticket.current;
    const snapshot = form;
    setPhase("validating");
    setError(null);
    setLocalIssues([]);
    setMessage(null);
    try {
      let stageId: string | null = null;
      if (snapshot.newFiles.length > 0) {
        const staged = await api<{ stageId: string }>("/api/firmware-library/stage", {
          method: "POST",
          body: JSON.stringify({ files: snapshot.newFiles }),
        });
        stageId = staged.stageId;
      }
      const result = await api<LibraryValidationResponse>("/api/firmware-library/validate", {
        method: "POST",
        body: JSON.stringify({
          name: snapshot.name,
          description: snapshot.description,
          type: snapshot.type,
          gpio: snapshot.gpio.map((row) => ({
            name: row.name.trim(),
            gpio: Number(row.gpio),
            description: row.description.trim(),
          })),
          stageId,
          componentId: snapshot.selectionId || null,
          retain: snapshot.retainedFiles.map((file) => file.name),
        }),
      });
      if (currentTicket !== ticket.current) return;
      setForm((current) => current === snapshot ? { ...current, validation: { ...result, stageId } } : current);
    } catch (reason) {
      if (currentTicket !== ticket.current) return;
      setError(reason instanceof Error ? reason.message : "Validation failed.");
    } finally {
      if (currentTicket === ticket.current) setPhase("idle");
    }
  }

  async function save() {
    if (!canSaveLibrary(form) || phase !== "idle") return;
    if (form.type !== "sensor" && form.type !== "actuator") return;
    if (!form.selectionId && !form.validation?.stageId) return;
    const savedName = form.name.trim();
    const currentTicket = ticket.current;
    setPhase("saving");
    setError(null);
    try {
      const body = {
        name: form.name,
        description: form.description,
        type: form.type,
        gpio: form.gpio.map((row) => ({
          name: row.name.trim(),
          gpio: Number(row.gpio),
          description: row.description.trim(),
        })),
        retain: form.selectionId ? form.retainedFiles.map((file) => file.name) : [],
        stageId: form.validation?.stageId ?? null,
        fingerprint: form.validation?.fingerprint,
        baseRevision: form.baseRevision,
      };
      const path = form.selectionId ? `/api/firmware-library/${form.selectionId}` : "/api/firmware-library";
      const response = await api<{ component: LibraryComponent }>(path, {
        method: form.selectionId ? "PUT" : "POST",
        body: JSON.stringify(body),
      });
      const listed = await api<{ components: LibraryComponent[] }>("/api/firmware-library");
      if (currentTicket !== ticket.current) return;
      setComponents(listed.components);
      if (currentTicket !== ticket.current) return;
      setLocalIssues([]);
      if (form.selectionId) {
        setForm(libraryFormFromComponent(response.component));
        setMessage(`Updated “${savedName}”. Its component ID is unchanged. Installed devices were not modified.`);
      } else {
        setForm(blankLibraryForm());
        setMessage(`Saved “${savedName}” to the Firmware Library. No device firmware was compiled or flashed.`);
      }
      scrollBuilderForm(document.getElementById("components"));
    } catch (reason) {
      if (currentTicket !== ticket.current) return;
      if (reason instanceof ApiError && reason.status === 404 && reason.code === "not_found") {
        setComponents((current) => current.filter((item) => item.id !== form.selectionId));
        setForm(blankLibraryForm());
        setError("That saved component is no longer in the Firmware Library. The form has been reset so you can create a new component.");
        return;
      }
      setError(reason instanceof ApiError ? reason.message : "The component could not be saved.");
    } finally {
      if (currentTicket === ticket.current) setPhase("idle");
    }
  }

  function openUpload(directory: boolean) {
    const input = uploadRef.current;
    if (!input) return;
    if (directory) {
      input.setAttribute("webkitdirectory", "");
      input.setAttribute("directory", "");
    } else {
      input.removeAttribute("webkitdirectory");
      input.removeAttribute("directory");
    }
    setUploadChoices(false);
    input.click();
  }

  async function addDropped(transfer: DataTransfer) {
    const entries = [...transfer.items]
      .map((item) => item.webkitGetAsEntry?.() ?? null)
      .filter((entry): entry is FileSystemEntry => entry != null);
    if (entries.length === 0) {
      await addUploads([...transfer.files].map((file) => ({ file, path: file.name })));
      return;
    }
    const collected: { file: File; path: string }[] = [];
    for (const entry of entries) {
      if (entry.isFile) {
        const file = await fileFromEntry(entry as FileSystemFileEntry);
        collected.push({ file, path: file.name });
      } else if (entry.isDirectory) {
        collected.push(...await filesInside(entry as FileSystemDirectoryEntry, ""));
      }
    }
    await addUploads(collected);
  }

  async function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    await addUploads([...list].map((file) => {
      const relative = file.webkitRelativePath;
      const path = relative.includes("/") ? relative.split("/").slice(1).join("/") : file.name;
      return { file, path };
    }));
  }

  async function addUploads(items: { file: File; path: string }[]) {
    if (items.length === 0) return;
    const rejected: string[] = [];
    const accepted: { file: File; name: string }[] = [];
    let skipped = 0;
    for (const item of items) {
      const file = item.file;
      const raw = item.path;
      if (!raw) continue;
      if (raw.split("/").some((part) => part === "build" || part === "managed_components" || part === "__MACOSX" || part === ".git" || part === ".vscode" || part === "backup" || part.startsWith("."))) {
        skipped += 1;
        continue;
      }
      if (file.size > 2_000_000) {
        rejected.push(`${file.name} is larger than 2 MB. Upload the component source, not an ESP-IDF build directory or managed components.`);
        continue;
      }
      const name = libraryUploadPath(raw);
      if (!name) {
        rejected.push(`${raw} is not a supported component file. Use C or C++ sources, headers, CMakeLists.txt, Kconfig, Kconfig.projbuild, or a component ZIP.`);
        continue;
      }
      accepted.push({ file, name });
    }
    if (skipped > 0) rejected.push(`${skipped} files from build output, managed components, backups, or hidden directories were left out.`);
    if (rejected.length > 0) setLocalIssues(rejected.slice(0, 8));
    if (accepted.length === 0) return;
    try {
      const encoded = await Promise.all(accepted.map((item) => encodeFile(item.file, item.name)));
      setForm((current) => addLibraryFiles(current, encoded));
      ticket.current += 1;
      setMessage(null);
      if (rejected.length === 0) setLocalIssues([]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The selected files could not be read.");
    }
  }

  const ready = canSaveLibrary(form) && phase === "idle";
  const errors = form.validation?.issues.filter((issue) => issue.level === "error") ?? [];
  const warnings = form.validation?.issues.filter((issue) => issue.level === "warning") ?? [];
  const notes = form.validation?.issues.filter((issue) => issue.level === "info") ?? [];
  return (
    <section className="stack">
      <header>
        <h1>Firmware Builder</h1>
        <p className="lede">Create, validate and manage reusable firmware components for sensors and actuators. Validated components are saved to the Firmware Library and can be used when building ESP32-H2 firmware.</p>
      </header>
      {message && <p className="banner ok" role="status">{message}</p>}
      {error && <p className="banner bad" role="alert">{error}</p>}
      <section className="stack" id="build-firmware">
        <h2>Build Firmware</h2>
        <form className="panel stack" onSubmit={(event) => event.preventDefault()} aria-busy={phase !== "idle"}>
          <fieldset className="plain stack builder-form" disabled={phase !== "idle"}>
          {form.selectionId && <p className="banner">Editing saved custom code. Update Firmware keeps the same component ID.</p>}
          <label>
            Code Source
            <select value={form.codeSource} aria-label="Code Source">
              <option value="upload">Upload Custom Code</option>
            </select>
          </label>
          <label>
            Firmware Name
            <input
              value={form.name}
              maxLength={80}
              required
              onChange={(event) => patch({ name: event.target.value })}
            />
          </label>
          <label>
            Description
            <textarea
              value={form.description}
              maxLength={600}
              required
              onChange={(event) => patch({ description: event.target.value })}
            />
          </label>
          <label>
            Component Type
            <select
              value={form.type}
              required
              onChange={(event) => patch({ type: event.target.value as LibraryFormState["type"] })}
            >
              <option value="">Select Sensor or Actuator</option>
              <option value="sensor">Sensor</option>
              <option value="actuator">Actuator</option>
            </select>
          </label>
          <div className="stack">
            <div
              className="combined-upload"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                void addDropped(event.dataTransfer);
              }}
            >
              <span>Upload Custom Code</span>
              <button type="button" className="secondary" aria-expanded={uploadChoices} aria-controls="upload-choices" onClick={() => setUploadChoices((open) => !open)}>
                Choose files or folder
              </button>
              {uploadChoices && (
                <div id="upload-choices" className="combined-upload-choices">
                  <button type="button" onClick={() => openUpload(false)}>Files</button>
                  <button type="button" onClick={() => openUpload(true)}>Folder</button>
                </div>
              )}
              <input
                ref={uploadRef}
                className="sr-only"
                type="file"
                multiple
                tabIndex={-1}
                aria-hidden="true"
                onChange={(event) => {
                  void addFiles(event.target.files);
                  event.target.value = "";
                }}
              />
            </div>
            <p className="muted">Choose source files or a component folder, or drop either one here. C and C++ sources, headers, CMakeLists.txt, Kconfig, Kconfig.projbuild, or one component ZIP. A folder keeps relative paths. Build directories and managed components are not component source.</p>
            {(form.retainedFiles.length > 0 || form.newFiles.length > 0) && (
              <ul className="file-list">
                {form.retainedFiles.map((file) => (
                  <li key={`saved-${file.name}`}>
                    <span>{file.name} · Saved file</span>
                    <button type="button" className="secondary" onClick={() => {
                      ticket.current += 1;
                      setForm((current) => removeRetainedFile(current, file.name));
                    }}>
                      Remove {file.name}
                    </button>
                  </li>
                ))}
                {form.newFiles.map((file) => (
                  <li key={`new-${file.name}`}>
                    <span>{file.name}</span>
                    <button type="button" className="secondary" onClick={() => {
                      ticket.current += 1;
                      setForm((current) => removeNewFile(current, file.name));
                    }}>
                      Remove {file.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <fieldset>
            <legend>GPIO Configuration</legend>
            {form.gpio.length === 0 && <p>No GPIO pins are configured.</p>}
            {form.gpio.map((row, index) => (
              <div className="gpio-grid" key={row.key}>
                <label>
                  Input or connection name
                  <input value={row.name} onChange={(event) => setForm((current) => updateGpioRow(current, row.key, { name: event.target.value }))} />
                </label>
                <label>
                  GPIO pin number
                  <input inputMode="numeric" value={row.gpio} onChange={(event) => setForm((current) => updateGpioRow(current, row.key, { gpio: event.target.value }))} />
                </label>
                <label>
                  Function Description
                  <input value={row.description} onChange={(event) => setForm((current) => updateGpioRow(current, row.key, { description: event.target.value }))} />
                </label>
                <button type="button" className="secondary" onClick={() => setForm((current) => removeGpioRow(current, row.key))}>
                  Remove{row.name.trim() ? ` ${row.name.trim()}` : index > 0 ? " GPIO" : ""}
                </button>
              </div>
            ))}
            <button type="button" className="secondary gpio-add" disabled={form.gpio.length >= 16} onClick={() => setForm((current) => addGpioRow(current))}>
              + Add GPIO Pin
            </button>
          </fieldset>
          {localIssues.length > 0 && (
            <div className="banner bad" role="alert">
              <ul>{localIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
            </div>
          )}
          {form.validation && (
            <div>
              <p>Errors: {errors.length}. Warnings: {warnings.length}. Native compile: {form.validation.nativeCompile ? "Succeeded" : "Not successful"}. Integration: {form.validation.integration ? form.validation.integration.signature : "Not verified"}. Eligible to save: {ready ? "Yes" : "No"}.</p>
            </div>
          )}
          {form.validation && errors.length > 0 && (
            <div className="banner bad" role="alert">
              <p>Validation failed.</p>
              <ul>{errors.map((issue, index) => <li key={`${issue.code}-${index}`}>{issueDetail(issue)}</li>)}</ul>
            </div>
          )}
          {warnings.length > 0 && (
            <div className="banner" role="status">
              <p>Warnings</p>
              <ul>{warnings.map((issue, index) => <li key={`${issue.code}-${index}`}>{issueDetail(issue)}</li>)}</ul>
            </div>
          )}
          {notes.length > 0 && (
            <ul>{notes.map((issue, index) => <li key={`${issue.code}-${index}`}>{issueDetail(issue)}</li>)}</ul>
          )}
          {form.validation?.files && form.validation.files.length > 0 && (
            <p className="muted">Files checked: {form.validation.files.map((file) => file.name).join(", ")}.</p>
          )}
          <div className="row">
            <button type="button" className="secondary" disabled={phase !== "idle"} onClick={() => void validate()}>
              Validate
            </button>
            <button type="button" disabled={!ready} onClick={() => void save()}>
              {saveLibraryLabel(form)}
            </button>
          </div>
          <p id="save-requirement" className="muted">{librarySaveRequirement(form, phase)}</p>
          <p className="muted">Create Firmware saves a reusable component. It does not compile or flash ESP32-H2 firmware.</p>
          </fieldset>
        </form>
      </section>
      <FirmwareLibrarySection components={components} pending={pending} onEdit={edit} onEditPending={(id) => void editPending(id)} />
    </section>
  );
}
