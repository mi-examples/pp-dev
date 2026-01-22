import {
  HtmlTagDescriptor,
  Plugin,
} from "vite";

export function miTopBarPlugin(
  integrateMiTopBar?:
    | boolean
    | { addRootElement?: boolean; addSharedComponentsScripts?: boolean }
): Plugin {
  return {
    name: "mi-topbar-plugin",
    transformIndexHtml() {
      const tags: HtmlTagDescriptor[] = [];

      if (
        integrateMiTopBar === true ||
        (typeof integrateMiTopBar === "object" && integrateMiTopBar.addRootElement === true)
      ) {
        tags.push({
          tag: "div",
          injectTo: "body-prepend",
          attrs: { id: "mi-react-root" },
        });
      }

      if (
        integrateMiTopBar === true ||
        (typeof integrateMiTopBar === "object" &&
          integrateMiTopBar.addSharedComponentsScripts === true)
      ) {
        tags.push(
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
          }
        );
      }

      return tags;
    },
  };
}
