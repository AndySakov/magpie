import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import { watchForDeploys } from "./freshness"
import "./styles.css"

watchForDeploys()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
