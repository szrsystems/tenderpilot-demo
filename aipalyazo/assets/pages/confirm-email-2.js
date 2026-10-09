/* confirm-email.html — moved out of the page so the CSP needs no 'unsafe-inline' for scripts. */
document.getElementById('resend-link').addEventListener('click',function(e){e.preventDefault();resendCode();});
