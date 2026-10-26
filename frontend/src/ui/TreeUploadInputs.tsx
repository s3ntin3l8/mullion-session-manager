import type { RefObject } from "react";

// The two hidden pickers behind a file tree's upload buttons: files, and a
// whole folder.
export function TreeUploadInputs({
  fileRef,
  folderRef,
  onPick,
}: {
  fileRef: RefObject<HTMLInputElement | null>;
  folderRef: RefObject<HTMLInputElement | null>;
  onPick: (files: FileList | null, input: HTMLInputElement) => void;
}) {
  return (
    <>
      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        aria-label="Upload files"
        onChange={(e) => onPick(e.target.files, e.target)}
      />
      <input
        ref={folderRef}
        type="file"
        hidden
        aria-label="Upload folder"
        // Non-standard but universal: a folder picker whose files carry
        // their path inside it on `webkitRelativePath`.
        {...({ webkitdirectory: "" } as Record<string, string>)}
        onChange={(e) => onPick(e.target.files, e.target)}
      />
    </>
  );
}
