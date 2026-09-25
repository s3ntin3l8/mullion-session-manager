import { BrowserFramerateSetting, BrowserPoolSizeSetting } from "../RuntimeSettings.js";
import { BrowserCookiesSection } from "./BrowserCookiesSection.js";

export function BrowserSection() {
  return (
    <>
      <BrowserFramerateSetting />
      <BrowserPoolSizeSetting />
      <div style={{ marginTop: 24 }}>
        <BrowserCookiesSection />
      </div>
    </>
  );
}
