import "./excalidraw-env";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./features.css";
import "./extensions.css";
import "./omarkie.css";
performance.mark("omarkie:renderer-bundle-evaluated");
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
// Browser builds work offline after the first visit; desktop hosts load from disk and never register it.
if (!window.desktop && import.meta.env.PROD && "serviceWorker" in navigator && window.isSecureContext)
  void navigator.serviceWorker.register("./sw.js").catch(error => console.warn("Offline cache unavailable:", error));
