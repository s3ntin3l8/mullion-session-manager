import { ChevronLeftIcon } from "../icons.js";
import { IconButton } from "./IconButton.js";
import { ViewHeader, type ViewHeaderProps } from "./ViewHeader.js";

export interface DetailHeaderProps extends Omit<ViewHeaderProps, "leading"> {
  onBack: () => void;
  backLabel?: string;
}

/** ViewHeader for a pushed in-sidebar detail view: back chevron + same slots. */
export function DetailHeader({ onBack, backLabel = "Back", ...rest }: DetailHeaderProps) {
  return (
    <ViewHeader
      {...rest}
      leading={
        <IconButton label={backLabel} onClick={onBack}>
          <ChevronLeftIcon size={14} />
        </IconButton>
      }
    />
  );
}
