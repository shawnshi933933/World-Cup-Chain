import { createRoot } from "react-dom/client";
import App from "./App";
import { AuthGate } from "./components/auth-gate";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <AuthGate>
    <App />
  </AuthGate>
);
