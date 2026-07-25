<?php
// ============================================================
// ShowPilot-Lite — "Open Viewer Page" redirect page
// ============================================================
// Sibling to open.php (see that file for the full rationale on why
// this needs to work both header()-redirect and client-side-redirect
// depending on whether FPP already wrapped the request in chrome).
// This one goes to the viewer page (Node app root "/") instead of
// the admin UI ("/admin/").
$host = $_SERVER['HTTP_HOST'] ?? $_SERVER['SERVER_ADDR'] ?? 'localhost';
$hostNoPort = preg_replace('/:\d+$/', '', $host);
$target = 'http://' . $hostNoPort . ':3100/';

if (!headers_sent()) {
    header('Location: ' . $target);
    exit;
}
?>
<!DOCTYPE html>
<html>
<head>
<meta http-equiv="refresh" content="0;url=<?php echo htmlspecialchars($target, ENT_QUOTES); ?>">
<script>location.replace(<?php echo json_encode($target); ?>);</script>
</head>
<body>
Redirecting to the ShowPilot-Lite viewer page&hellip;
<a href="<?php echo htmlspecialchars($target, ENT_QUOTES); ?>"><?php echo htmlspecialchars($target, ENT_QUOTES); ?></a>
</body>
</html>
<?php exit; ?>
