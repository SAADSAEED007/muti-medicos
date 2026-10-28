$(document).ready(function () {
  // The POS product list owns its filtering logic in pos.js. The on-screen
  // keyboard may update the input without emitting a native input event, so
  // forward its clicks to that single filter handler.
  $("body").on("click", "#jq-keyboard button", function () {
    if ($("#search").is(":focus")) {
      setTimeout(function () { $("#search").trigger("input"); }, 0);
    }
  });

  function searchOpenOrders() {
    var matcher = new RegExp($("#holdOrderInput").val(), "gi");
    $(".order")
      .show()
      .not(function () {
        return matcher.test($(this).find(".ref_number").text());
      })
      .hide();
  }

  var $searchHoldOrder = $("#holdOrderInput").on("input", function () {
    searchOpenOrders();
  });

  $("body").on("click", ".holdOrderKeyboard .key", function () {
    if ($("#holdOrderInput").is(":focus")) {
      searchOpenOrders();
    }
  });

  function searchCustomerOrders() {
    var matcher = new RegExp($("#holdCustomerOrderInput").val(), "gi");
    $(".customer-order")
      .show()
      .not(function () {
        return matcher.test($(this).find(".customer_name").text());
      })
      .hide();
  }

  $("#holdCustomerOrderInput").on("input", function () {
      searchCustomerOrders();
    }
  );

  $("body").on("click", ".customerOrderKeyboard .key", function () {
    if ($("#holdCustomerOrderInput").is(":focus")) {
      searchCustomerOrders();
    }
  });

});
