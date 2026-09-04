import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCreateSpace } from "../api/queries";
import Modal from "./Modal";

export default function CreateSpaceModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const create = useCreateSpace();
  const nav = useNavigate();
  const trimmed = name.trim();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    // Guards the button's disabled state too: a disabled submit button does
    // not stop a raw form-submit event (e.g. from an Enter key) from firing,
    // so whitespace-only names must be rejected here, not just left to the
    // disabled attribute.
    if (!trimmed) return;
    create.mutate(trimmed, {
      onSuccess: (space) => { onClose(); nav(`/space/${space.id}`); },
    });
  };

  return (
    <Modal title="Create a space" onClose={onClose}>
      <form className="modal-form" onSubmit={submit}>
        <label htmlFor="space-name">Name</label>
        <input
          id="space-name" type="text" autoFocus value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {create.isError && <p role="alert" className="field-error">{(create.error as Error).message}</p>}
        <button type="submit" className="btn-primary" disabled={create.isPending || !trimmed}>
          {create.isPending ? "Creating…" : "Create space"}
        </button>
      </form>
    </Modal>
  );
}
