// Protect PDF: set an open password + permissions, then write a protected
// copy via Save As. AES-128 today (lopdf V4); AES-256 arrives with qpdf.
import { useState } from "react";
import { commands } from "../telos";
import { useApp, type OpenDoc } from "../store";

export default function ProtectModal({
  doc,
  onClose,
}: {
  doc: OpenDoc;
  onClose: () => void;
}) {
  const showToast = useApp((s) => s.showToast);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [owner, setOwner] = useState("");
  const [allowPrint, setAllowPrint] = useState(true);
  const [allowCopy, setAllowCopy] = useState(true);
  const [allowAnnotate, setAllowAnnotate] = useState(true);
  const [allowModify, setAllowModify] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    if (!password) {
      setError("Enter a password.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    try {
      const path = await commands.protectDocument(
        doc.info.id,
        password,
        owner,
        allowPrint,
        allowCopy,
        allowModify,
        allowAnnotate,
        doc.info.title,
      );
      onClose();
      if (path) showToast(`Protected copy saved to ${path}`);
    } catch (e) {
      setError(String(e));
    }
  };

  const Check = ({
    label,
    value,
    onChange,
  }: {
    label: string;
    value: boolean;
    onChange: (v: boolean) => void;
  }) => (
    <label className="perm-check">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h3>Protect PDF</h3>
        <p className="modal-body-text">
          Writes a password-protected copy (AES-128 — AES-256 lands with the qpdf engine).
          Opening it will require the password. The open mechanism is public; only your
          password is the secret.
        </p>
        <input
          autoFocus
          className="code-input"
          type="password"
          placeholder="Password (required to open)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <input
          className="code-input"
          type="password"
          placeholder="Confirm password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <input
          className="code-input"
          type="password"
          placeholder="Owner password (optional — full-access password)"
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
        />
        <div className="perm-grid">
          <Check label="Allow printing" value={allowPrint} onChange={setAllowPrint} />
          <Check label="Allow copying text" value={allowCopy} onChange={setAllowCopy} />
          <Check label="Allow comments & forms" value={allowAnnotate} onChange={setAllowAnnotate} />
          <Check label="Allow editing" value={allowModify} onChange={setAllowModify} />
        </div>
        {error && <p className="modal-error">{error}</p>}
        <div className="modal-actions">
          <button className="modal-primary" onClick={() => void submit()}>
            Protect & Save As…
          </button>
          <button className="modal-secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
