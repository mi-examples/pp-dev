import { Plugin } from "vite";

export function miTopBarPlugin(): Plugin {
  return {
    name: "mi-topbar-plugin",
    transformIndexHtml() {
      return [
        {
          tag: "script",
          injectTo: "head-prepend",
          attrs: { src: "/auth/info.js" },
        },
        {
          tag: "script",
          injectTo: "head-prepend",
          attrs: { src: "/js/main.js", defer: "defer" },
        },
        {
          tag: "link",
          injectTo: "head-prepend",
          attrs: { href: "/css/main.css", rel: "stylesheet" },
        },
        {
          tag: "div",
          injectTo: "body-prepend",
          attrs: {
            id: "mi-react-root",
          },
        },
      ];
    },
  };
}
