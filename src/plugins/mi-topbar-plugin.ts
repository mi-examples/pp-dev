import { Plugin } from "vite";

export function miTopBarPlugin(): Plugin {
  return {
    name: "mi-topbar-plugin",
    transformIndexHtml() {
      return [
        {
          tag: "script",
          injectTo: "body",
          attrs: { src: "/auth/info.js" },
        },
        {
          tag: "script",
          injectTo: "body",
          attrs: { src: "/js/main.js", defer: "defer" },
        },
        {
          tag: "link",
          injectTo: "head",
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
