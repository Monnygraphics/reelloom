// Sends the beta and feedback forms to a Formspree inbox. No keys here: a Formspree form id is public by design.
(function () {
  var ENDPOINT = "https://formspree.io/f/mppqyopa";
  var DONE = {
    beta: "You are registered. Check your email: we will send your access details as each part of the editor opens.",
    feedback: "Thank you. Your feedback was sent."
  };
  document.querySelectorAll("form.form").forEach(function (form) {
    var status = form.querySelector(".status");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      status.className = "status";
      var bad = form.querySelector(":invalid");
      if (bad) { status.textContent = "Please fill in the required fields."; status.classList.add("err"); bad.focus(); return; }
      var data = new FormData(form);
      data.append("form", form.dataset.kind);
      var btn = form.querySelector("button[type=submit]");
      btn.disabled = true; status.textContent = "Sending...";
      fetch(ENDPOINT, { method: "POST", body: data, headers: { Accept: "application/json" } })
        .then(function (r) {
          if (!r.ok) throw new Error("bad status");
          form.reset(); status.textContent = DONE[form.dataset.kind]; status.classList.add("ok");
        })
        .catch(function () { status.textContent = "Could not send. Please try again in a moment."; status.classList.add("err"); })
        .then(function () { btn.disabled = false; });
    });
  });
})();
