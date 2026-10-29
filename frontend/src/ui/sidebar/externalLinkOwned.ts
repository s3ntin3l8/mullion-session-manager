import { createContext } from "react";

/**
 * True where something above the header already carries the open-on-GitHub
 * link (the right sidebar's toolbar), so the header does not repeat it.
 */
export const ExternalLinkOwnedContext = createContext(false);
