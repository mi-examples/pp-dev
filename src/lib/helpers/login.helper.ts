declare const host: string;

export const tokenLoginFunction = function () {
  const readyInterval = setInterval(function () {
    if (document.querySelector<HTMLFormElement>('#mi-react-root form')) {
      // ready
      clearInterval(readyInterval);

      const $loginForm = document.querySelector<HTMLFormElement>('#mi-react-root form');
      const $contentWrapper = $loginForm?.firstChild as HTMLDivElement;

      const $rowTemplate = ($contentWrapper.lastChild as HTMLDivElement).cloneNode(true) as HTMLDivElement;
      $rowTemplate.innerHTML = '';

      const $orRow = $rowTemplate.cloneNode(true) as HTMLDivElement;
      $orRow.innerText = 'OR';

      const $helperForm = $rowTemplate.cloneNode(true) as HTMLDivElement;

      const $formContent = document.createElement('div');

      const formHtml = /** HTML */ `
<style>
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
  /*padding: 12px;*/
  border-radius: 4px;
  width: 100%;
  box-sizing: border-box;
  text-align: center;
  height: 26px;
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
}

.helper-login-wrapper .footer .btn.submit:hover {
  background-color: #0056b3;
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
</style>
<div class="helper-login-wrapper">
  <div class="title">PP Dev Helper</div>

  <div class="token-type-switcher" id="token-type-switcher">
    <div class="token-type-option active" data-value="personal">
      API Token
    </div>
    <div class="token-type-option" data-value="regular">
      Legacy Token
    </div>
  </div>

  <div class="control">
    <input type="password" id="helper-token" placeholder="API Token">
    <span class="caption" id="token-caption">
      You can get the API Token
      <a href="https://${host}/api-token" target="_blank" style="color: #007bff; text-decoration: none;">here</a>
    </span>
  </div>

  <div class="footer">
    <button id="helper-token-submit" class="btn submit">
      Token Login
    </button>
  </div>
</div>`;

      $formContent.innerHTML = formHtml;

      $helperForm.appendChild($formContent);

      $contentWrapper.appendChild($orRow);
      $contentWrapper.appendChild($helperForm);

      // Add token type change handler
      const tokenTypeSwitcher = document.getElementById('token-type-switcher');
      const tokenTypeOptions = tokenTypeSwitcher?.querySelectorAll('.token-type-option');
      const tokenInput = document.getElementById('helper-token') as HTMLInputElement;
      const tokenCaption = document.getElementById('token-caption') as HTMLSpanElement;

      const tokenInfo = {
        personal: {
          placeholder: 'API Token',
          caption: `You can get the API Token
            <a href="https://${host}/api-token" target="_blank" 
               style="color: #007bff; text-decoration: none;">here</a>`,
        },
        regular: {
          placeholder: 'Legacy Token',
          caption: `You can get the Legacy Token
            <a href="https://${host}/api/get_token" target="_blank" 
               style="color: #007bff; text-decoration: none;">here</a>`,
        },
      };

      const updateTokenUI = (type: 'personal' | 'regular') => {
        const info = tokenInfo[type];

        if (info) {
          tokenInput.placeholder = info.placeholder;
          tokenCaption.innerHTML = info.caption;
        }
      };

      // Initial UI setup for default type (personal)
      updateTokenUI('personal');

      tokenTypeOptions?.forEach((option) => {
        option.addEventListener('click', (e) => {
          const target = e.currentTarget as HTMLDivElement;
          const value = target.dataset.value as 'personal' | 'regular';

          // Update active class
          tokenTypeOptions.forEach((opt) => opt.classList.remove('active'));
          target.classList.add('active');

          // Update UI
          updateTokenUI(value);
        });
      });

      document.getElementById('helper-token-submit')?.addEventListener('click', (e) => {
        e.preventDefault();

        const $helperTokenInput = document.getElementById('helper-token') as HTMLInputElement;

        if ($helperTokenInput) {
          if (!$helperTokenInput.value) {
            // Use placeholder in alert message
            alert(`${tokenInput.placeholder} is required`);

            return;
          }

          const token = $helperTokenInput.value;
          const activeOption = tokenTypeSwitcher?.querySelector('.token-type-option.active') as HTMLDivElement;
          const tokenType = activeOption?.dataset.value || 'personal';

          fetch('/@api/login', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              token,
              tokenType,
            }),
            redirect: 'follow',
          })
            .then(async (res) => {
              const url = res.url && new URL(res.url, window.location.origin);

              if (url && !url.pathname.startsWith('/login') && !url.pathname.startsWith('/@api/')) {
                window.location.href = res.url;
              } else {
                try {
                  const json = await res.json();

                  alert(`Login failed: ${json?.error}`);
                } catch (e) {
                  alert('Login failed: Unknown error');
                }
              }
            })
            .catch(() => {
              alert('Login failed');
            });
        }
      });
    }
  }, 100);
};
