import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { z } from "zod";

/** The pinned V2 preview publishes extensionless and directory ESM imports. */
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const code = z.object({ code: z.string() }).safeParse(error);
      if (
        !context.parentURL?.includes("/@opencode/") ||
        !code.success ||
        !["ERR_MODULE_NOT_FOUND", "ERR_UNSUPPORTED_DIR_IMPORT"].includes(code.data.code)
      )
        throw error;
      return nextResolve(
        pathToFileURL(createRequire(context.parentURL).resolve(specifier)).href,
        context,
      );
    }
  },
});
