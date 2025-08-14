declare const host: string;

export const tokenLoginFunction = function () {
  // Types and interfaces (will be removed when converted to string)
  type TokenType = "personal" | "regular";

  // Constants
  const TOKEN_TYPE_CONFIG = {
    personal: {
      placeholder: "API Token",
      caption: `You can get the API Token
        <a href="https://${host}/api-token" target="_blank" 
           style="color: #007bff; text-decoration: none;">here</a>`,
      endpoint: "/@api/login",
    },
    regular: {
      placeholder: "Legacy Token",
      caption: `You can get the Legacy Token
        <a href="https://${host}/api/get_token" target="_blank" 
           style="color: #007bff; text-decoration: none;">here</a>`,
      endpoint: "/@api/login",
    },
  };

  const CSS_STYLES = /** CSS */ `
.helper-login-wrapper {
  font-family: Arial, sans-serif;
  color: #222;
  padding: 8px;
  background-color: #f8f9fa;
  border-radius: 8px;
  border: 1px solid #ddd;
  width: 100%;
  max-width: 400px;
  margin: 0 auto;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.helper-login-wrapper .title {
  font-weight: bold;
  font-size: 18px;
  margin-bottom: 12px;
  text-align: center;
}

.helper-login-wrapper .control {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.helper-login-wrapper .control input {
  border: 1px solid #ddd;
  border-radius: 4px;
  width: 100%;
  box-sizing: border-box;
  text-align: center;
  height: 26px;
  padding: 0 8px;
  font-size: 14px;
}

.helper-login-wrapper .control input:focus {
  outline: none;
  border-color: #007bff;
  box-shadow: 0 0 0 2px rgba(0, 123, 255, 0.25);
}

.helper-login-wrapper .control .caption {
  font-size: 12px;
  color: #666;
  text-align: center;
}

.helper-login-wrapper .footer {
  margin-top: 16px;
  text-align: center;
}

.helper-login-wrapper .footer .btn.submit {
  background-color: #007bff;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  width: 100%;
  font-size: 14px;
  transition: background-color 0.3s;
  height: 26px;
  font-weight: 500;
}

.helper-login-wrapper .footer .btn.submit:hover {
  background-color: #0056b3;
}

.helper-login-wrapper .footer .btn.submit:disabled {
  background-color: #6c757d;
  cursor: not-allowed;
}

.helper-login-wrapper .token-type-switcher {
  display: flex;
  border: 1px solid #ccc;
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 12px;
  width: 100%;
}

.helper-login-wrapper .token-type-option {
  padding: 4px 8px;
  cursor: pointer;
  background-color: #f8f9fa;
  color: #666;
  font-size: 12px;
  text-align: center;
  transition: background-color 0.2s, color 0.2s;
  border-right: 1px solid #ccc;
  flex: 1;
  user-select: none;
}

.helper-login-wrapper .token-type-option:last-child {
  border-right: none;
}

.helper-login-wrapper .token-type-option.active {
  background-color: #007bff;
  color: white;
  font-weight: bold;
}

.helper-login-wrapper .token-type-option:not(.active):hover {
  background-color: #e9ecef;
}

.helper-login-wrapper .error-message {
  color: #dc3545;
  font-size: 12px;
  text-align: center;
  margin-top: 8px;
  display: none;
}

.helper-login-wrapper .error-message.show {
  display: block;
}

.helper-login-wrapper .loading {
  opacity: 0.6;
  pointer-events: none;
}
`;

  // Helper functions
  function createLoginFormHTML() {
    return `
<div class="helper-login-wrapper" role="form" aria-label="PP Dev Helper Login">
  <div class="title" role="heading" aria-level="2">PP Dev Helper</div>

  <div class="token-type-switcher" id="token-type-switcher" role="tablist" aria-label="Token type selection">
    <div class="token-type-option active" data-value="personal" role="tab" aria-selected="true" tabindex="0">
      API Token
    </div>
    <div class="token-type-option" data-value="regular" role="tab" aria-selected="false" tabindex="0">
      Legacy Token
    </div>
  </div>

  <div class="control">
    <input 
      type="password" 
      id="helper-token" 
      placeholder="API Token"
      aria-label="Token input"
      aria-describedby="token-caption"
    >
    <span class="caption" id="token-caption">
      You can get the API Token
      <a href="https://${host}/api-token" target="_blank" style="color: #007bff; text-decoration: none;">here</a>
    </span>
  </div>

  <div class="error-message" id="error-message" role="alert" aria-live="polite"></div>

  <div class="footer">
    <button id="helper-token-submit" class="btn submit" type="button">
      Token Login
    </button>
  </div>
</div>`;
  }

  function updateTokenUI(
    type: TokenType,
    tokenInput: HTMLInputElement,
    tokenCaption: HTMLSpanElement
  ) {
    const info = TOKEN_TYPE_CONFIG[type];

    if (info) {
      tokenInput.placeholder = info.placeholder;
      tokenCaption.innerHTML = info.caption;
    }
  }

  function showError(message: string, errorElement: HTMLDivElement) {
    errorElement.textContent = message;
    errorElement.classList.add("show");
  }

  function hideError(errorElement: HTMLDivElement) {
    errorElement.classList.remove("show");
  }

  function setupTokenTypeSwitcher(
    tokenTypeSwitcher: HTMLElement,
    tokenInput: HTMLInputElement,
    tokenCaption: HTMLSpanElement
  ) {
    const tokenTypeOptions =
      tokenTypeSwitcher.querySelectorAll<HTMLDivElement>(".token-type-option");

    const handleTokenTypeChange = (target: HTMLDivElement) => {
      const value = target.dataset.value as TokenType;

      // Update active class and ARIA attributes
      tokenTypeOptions.forEach((opt) => {
        opt.classList.remove("active");
        opt.setAttribute("aria-selected", "false");
        opt.setAttribute("tabindex", "-1");
      });

      target.classList.add("active");
      target.setAttribute("aria-selected", "true");
      target.setAttribute("tabindex", "0");

      // Update UI
      updateTokenUI(value, tokenInput, tokenCaption);
    };

    // Click handler
    tokenTypeOptions.forEach((option) => {
      option.addEventListener("click", (e) => {
        const target = e.currentTarget as HTMLDivElement;

        handleTokenTypeChange(target);
      });

      // Keyboard navigation
      option.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleTokenTypeChange(option);
        }
      });
    });
  }

  async function handleFormSubmission(
    token: string,
    tokenType: TokenType,
    formWrapper: HTMLElement,
    errorElement: HTMLDivElement
  ) {
    try {
      // Show loading state
      formWrapper.classList.add("loading");

      const response = await fetch("/@api/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token, tokenType }),
        redirect: "follow",
      });

      const url = response.url && new URL(response.url, window.location.origin);

      if (
        url &&
        !url.pathname.startsWith("/login") &&
        !url.pathname.startsWith("/@api/")
      ) {
        // Successful login - redirect
        window.location.href = response.url;
      } else {
        // Login failed
        try {
          const json = await response.json();
          const errorMessage = json?.error || "Unknown error occurred";

          showError(`Login failed: ${errorMessage}`, errorElement);
        } catch (parseError) {
          showError("Login failed: Unable to parse response", errorElement);
        }
      }
    } catch (networkError) {
      showError(
        "Login failed: Network error. Please check your connection.",
        errorElement
      );
    } finally {
      // Remove loading state
      formWrapper.classList.remove("loading");
    }
  }

  function setupEventHandlers(
    formWrapper: HTMLElement,
    tokenInput: HTMLInputElement,
    submitButton: HTMLButtonElement,
    errorElement: HTMLDivElement
  ) {
    // Submit button click handler
    submitButton.addEventListener("click", async (e) => {
      e.preventDefault();
      hideError(errorElement);

      if (!tokenInput.value.trim()) {
        showError(`${tokenInput.placeholder} is required`, errorElement);
        tokenInput.focus();

        return;
      }

      const tokenTypeSwitcher = document.getElementById("token-type-switcher");
      const activeOption = tokenTypeSwitcher?.querySelector(
        ".token-type-option.active"
      ) as HTMLDivElement;
      const tokenType = (activeOption?.dataset.value ||
        "personal") as TokenType;

      await handleFormSubmission(
        tokenInput.value.trim(),
        tokenType,
        formWrapper,
        errorElement
      );
    });

    // Enter key handler for input
    tokenInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submitButton.click();
      }
    });

    // Clear error on input change
    tokenInput.addEventListener("input", () => {
      hideError(errorElement);
    });
  }

  function initializeLoginForm(loginForm: HTMLFormElement) {
    const contentWrapper = loginForm.firstChild as HTMLDivElement;

    if (!contentWrapper) {
      return;
    }

    // Create form elements
    const rowTemplate = (contentWrapper.lastChild as HTMLDivElement)?.cloneNode(
      true
    ) as HTMLDivElement;

    if (!rowTemplate) {
      return;
    }

    rowTemplate.innerHTML = "";

    const orRow = rowTemplate.cloneNode(true) as HTMLDivElement;

    orRow.innerText = "OR";
    orRow.setAttribute("role", "separator");
    orRow.setAttribute("aria-label", "Alternative login method");

    const helperForm = rowTemplate.cloneNode(true) as HTMLDivElement;
    const formContent = document.createElement("div");

    // Add styles and form HTML
    const styleElement = document.createElement("style");
  
    styleElement.textContent = CSS_STYLES;
    document.head.appendChild(styleElement);

    formContent.innerHTML = createLoginFormHTML();
    helperForm.appendChild(formContent);

    // Add to DOM
    contentWrapper.appendChild(orRow);
    contentWrapper.appendChild(helperForm);

    // Get form elements
    const tokenTypeSwitcher = document.getElementById("token-type-switcher");
    const tokenInput = document.getElementById(
      "helper-token"
    ) as HTMLInputElement;
    const tokenCaption = document.getElementById(
      "token-caption"
    ) as HTMLSpanElement;
    const submitButton = document.getElementById(
      "helper-token-submit"
    ) as HTMLButtonElement;
    const errorElement = document.getElementById(
      "error-message"
    ) as HTMLDivElement;
    const formWrapper = formContent.querySelector(
      ".helper-login-wrapper"
    ) as HTMLElement;

    if (
      !tokenTypeSwitcher ||
      !tokenInput ||
      !tokenCaption ||
      !submitButton ||
      !errorElement ||
      !formWrapper
    ) {
      console.error("Failed to find required form elements");

      return;
    }

    // Setup event handlers
    setupTokenTypeSwitcher(tokenTypeSwitcher, tokenInput, tokenCaption);
    setupEventHandlers(formWrapper, tokenInput, submitButton, errorElement);

    // Initial UI setup
    updateTokenUI("personal", tokenInput, tokenCaption);
  }

  // Main logic - use MutationObserver instead of setInterval for better performance
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "childList") {
        const loginForm = document.querySelector<HTMLFormElement>(
          "#mi-react-root form"
        );

        if (loginForm) {
          observer.disconnect();
          initializeLoginForm(loginForm);
          break;
        }
      }
    }
  });

  // Start observing
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // Fallback: check if form already exists
  const existingForm = document.querySelector<HTMLFormElement>(
    "#mi-react-root form"
  );
  
  if (existingForm) {
    observer.disconnect();
    initializeLoginForm(existingForm);
  }
};
