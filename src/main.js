import { createApp } from "vue";
import App from "./App.vue";
import "./style.css"; // default Vite styles

const app = createApp(App);
app.config.performance = import.meta.env.DEV;
app.mount("#app");
