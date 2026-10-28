const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

let testPassed = false;

app.on('browser-window-created', (_event, window) => {
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.error('RENDERER ERROR:', message);
  });

  let loadCount = 0;
  window.webContents.on('did-finish-load', async () => {
    loadCount++;
    console.log(`ELECTRON WINDOW LOADED (load #${loadCount})`);

    try {
      let isMainAppVisible = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        const status = await window.webContents.executeJavaScript(`(() => {
          const login = document.querySelector('#login');
          const mainApp = document.querySelector('#main_app');
          return {
            loginVisible: login ? getComputedStyle(login).display !== 'none' : false,
            mainAppVisible: mainApp ? getComputedStyle(mainApp).display !== 'none' : false
          };
        })()`);

        if (status.mainAppVisible) {
          isMainAppVisible = true;
          break;
        }

        if (status.loginVisible) {
          console.log('Login screen visible. Submitting credentials...');
          await window.webContents.executeJavaScript(`(() => {
            const uInput = document.querySelector('#account input[name="username"]');
            const pInput = document.querySelector('#account input[name="password"]');
            if (uInput && pInput) {
              uInput.value = 'admin';
              pInput.value = 'Password12345!';
              const form = document.querySelector('#account');
              if (form) $(form).trigger('submit');
            }
          })()`);
          return;
        }

        await new Promise(r => setTimeout(r, 500));
      }

      if (!isMainAppVisible) {
        console.error('Timed out waiting for mainApp to become visible');
        app.exit(1);
        return;
      }

      // Wait for product card to render into #parent
      for (let i = 0; i < 20; i++) {
        const hasCard = await window.webContents.executeJavaScript(`(() => {
          return !!document.querySelector('#parent .product-card-item, #parent .box');
        })()`);
        if (hasCard) break;
        await new Promise(r => setTimeout(r, 400));
      }

      const state = await window.webContents.executeJavaScript(`(() => {
        const splash = document.querySelector('.splash');
        const login = document.querySelector('#login');
        const mainApp = document.querySelector('#main_app');
        const enterpriseNav = document.querySelector('.enterprise-nav');
        const posView = document.querySelector('#pos_view');
        const payButton = document.querySelector('#payButton');
        const cartBody = document.querySelector('#cartTable .card-body');
        const parentGrid = document.querySelector('#parent');

        const payRect = payButton ? payButton.getBoundingClientRect() : null;
        const posRect = posView ? posView.getBoundingClientRect() : null;
        const parentRect = parentGrid ? parentGrid.getBoundingClientRect() : null;
        const whiteBox = parentGrid ? parentGrid.closest('.card-box') : null;
        const whiteBoxRect = whiteBox ? whiteBox.getBoundingClientRect() : null;
        const firstCard = document.querySelector('#parent .product-card-item, #parent .box');
        const cardRect = firstCard ? firstCard.getBoundingClientRect() : null;

        return {
          windowHeight: window.innerHeight,
          windowWidth: window.innerWidth,
          bodyScrollHeight: document.body.scrollHeight,
          docScrollHeight: document.documentElement.scrollHeight,
          splashVisible: splash ? (getComputedStyle(splash).display !== 'none' && getComputedStyle(splash).opacity !== '0') : false,
          mainAppDisplay: mainApp ? getComputedStyle(mainApp).display : 'null',
          posViewDisplay: posView ? getComputedStyle(posView).display : 'null',
          payButtonVisible: payButton ? (payRect.top >= 0 && payRect.bottom <= window.innerHeight) : false,
          payButtonBottom: payRect ? Math.round(payRect.bottom) : null,
          cartBodyHeight: cartBody ? cartBody.clientHeight : null,
          parentGridHeight: parentGrid ? parentGrid.clientHeight : null,
          whiteBoxLeft: whiteBoxRect ? Math.round(whiteBoxRect.left) : null,
          whiteBoxRight: whiteBoxRect ? Math.round(whiteBoxRect.right) : null,
          cardLeft: cardRect ? Math.round(cardRect.left) : null,
          cardRight: cardRect ? Math.round(cardRect.right) : null,
          cardInsideWhiteBox: (whiteBoxRect && cardRect) ? (cardRect.left >= whiteBoxRect.left && cardRect.right <= whiteBoxRect.right) : null,
          cardOffsetFromLeftBorder: (whiteBoxRect && cardRect) ? Math.round(cardRect.left - whiteBoxRect.left) : null
        };
      })()`);

      console.log('UI MEASUREMENT:', JSON.stringify(state, null, 2));

      if (state.cardInsideWhiteBox) {
        console.log(`VERIFICATION SUCCESS: Product card is inside white box! Left offset from box: ${state.cardOffsetFromLeftBorder}px (>=0)`);
        testPassed = true;
      } else if (state.cardOffsetFromLeftBorder !== null && state.cardOffsetFromLeftBorder >= 0) {
        console.log(`VERIFICATION SUCCESS: Product card offset from left border is ${state.cardOffsetFromLeftBorder}px >= 0`);
        testPassed = true;
      }
      if (testPassed) {
        process.exitCode = 0;
        app.exit(0);
      } else {
        process.exitCode = 1;
        app.exit(1);
      }
    } catch (e) {
      if (!testPassed) {
        console.error('Error querying UI state:', e);
        app.exit(1);
      }
    }
  });
});

require('../start');
