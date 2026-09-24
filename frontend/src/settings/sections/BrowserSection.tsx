import { BrowserFramerateSetting } from "../RuntimeSettings.js";
import { BrowserCookiesSection } from "./BrowserCookiesSection.js";

export function BrowserSection() {
  return (
    <>
      <BrowserFramerateSetting />
      <div style={{ marginTop: 24 }}>
        <BrowserCookiesSection />
      </div>
    </>
  );
}
