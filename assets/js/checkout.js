const utils = require("./utils");

/** CheckOut Functions **/
$(document).ready(function () {
  /**
   * handle keypad button pressed.
   * @param {string} value - The keypad value to be processed.
   * @param {boolean} isDueInput - Indicates whether the input is for due payment.
   */
  $.fn.keypadBtnPressed = function (value, isDueInput) {
    let paymentAmount = $("#payment").val();
    if (isDueInput) {
      $("#refNumber").val($("#refNumber").val() + "" + value);
    } else {
      paymentAmount = paymentAmount + "" + value;
      $("#paymentText").val(utils.moneyFormat(paymentAmount));
      $("#payment").val(paymentAmount);
      $(this).calculateChange();
    }
  };

  /**
   * Format payment amount with commas when a point is pressed
   */
  $.fn.digits = function () {
    let paymentAmount = $("#payment").val();
    $("#paymentText").val(utils.moneyFormat(paymentAmount));
    $("#payment").val(paymentAmount + ".");
    $(this).calculateChange();
  };

  /**
   * Calculate and display the balance due.
   */
  $.fn.calculateChange = function () {
    var payablePrice = parseFloat($("#payablePrice").val().replace(/,/g, "")) || 0;
    var payment = parseFloat($("#payment").val().replace(/,/g, "")) || 0;
    var change = payablePrice - payment;
    var isCredit = $(".list-group-item.active").data("payment-type") == 4;
    var hasCustomer = $("#customer").val() && $("#customer").val() != "0";

    if (change <= 0) {
      $("#change").text(utils.moneyFormat(Math.abs(change.toFixed(2))));
      $("#confirmPayment").show();
      $("#creditNotice").remove();
    } else if (isCredit || hasCustomer) {
      $("#change").text("0 (Due: " + utils.moneyFormat(change.toFixed(2)) + ")");
      $("#confirmPayment").show();
      if (!$("#creditNotice").length) {
        $("#confirmPayment").before('<div id="creditNotice" style="font-size:12px;color:#0e8045;margin-bottom:6px;font-weight:600;text-align:center;"><i class="fa fa-info-circle"></i> Credit Sale: Due balance will post to Customer Khata</div>');
      }
    } else {
      $("#change").text("0");
      $("#confirmPayment").hide();
      $("#creditNotice").remove();
    }
  };

  var $keypadBtn = $(".keypad-btn").on("click", function () {
    const key = $(this).data("val");
    const isdue = $(this).data("isdue");
    switch(key)
    {
    case "del" : { 
      if(isdue)
      {
        $('#refNumber').val((i, val) => val.slice(0, -1));
      }
      else
      {
        $("#payment").val((i, val) => val.slice(0, -1));
      //re-format displayed amount after deletion 
      $("#paymentText").val((i, val) => utils.moneyFormat($("#payment").val()));
      }
      $(this).calculateChange()
    }; break;

    case "ac":{
      if(isdue)
      {
          $('#refNumber').val('');
      }
      else
      {
        $('#payment,#paymentText').val('');
        $(this).calculateChange();
      }
       
    };break;

  case "point": {
    $(this).digits()
    };break;

   default: $(this).keypadBtnPressed(key, isdue); break;
  }
});

  /** Switch Views for Payment Options **/
  var $list = $(".list-group-item").on("click", function () {
    $list.removeClass("active");
    $(this).addClass("active");
    if (this.id == "check") {
      $("#cardInfo").show();
      $("#cardInfo .input-group-addon").text("Check Info");
      if ($("#payment").val() === "0") { $("#payment,#paymentText").val(""); }
    } else if (this.id == "card") {
      $("#cardInfo").show();
      $("#cardInfo .input-group-addon").text("Card Info");
      if ($("#payment").val() === "0") { $("#payment,#paymentText").val(""); }
    } else if (this.id == "cash") {
      $("#cardInfo").hide();
      if ($("#payment").val() === "0") { $("#payment,#paymentText").val(""); }
    } else if (this.id == "creditPaymentBtn") {
      $("#cardInfo").hide();
      var custVal = $("#customer").val();
      if (!custVal || custVal == "0") {
        if (typeof notiflix !== "undefined") {
          notiflix.Report.warning("Customer Required", "Credit / Khata sale requires selecting a registered customer from the customer dropdown first.", "Ok");
        }
      }
      if ($("#payment").val() === "") {
        $("#payment").val("0");
        $("#paymentText").val("0.00");
      }
    }
    $.fn.calculateChange();
  });
});