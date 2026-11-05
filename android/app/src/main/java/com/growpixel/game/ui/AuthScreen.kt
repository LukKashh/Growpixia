package com.growpixel.game.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.growpixel.game.auth.AuthManager
import com.growpixel.game.auth.AuthUser
import kotlinx.coroutines.launch

@Composable
fun AuthScreen(
    authManager: AuthManager,
    onAuthSuccess: (AuthUser) -> Unit
) {
    val context = LocalContext.current
    val coroutineScope = rememberCoroutineScope()

    var isRegisterMode by remember { mutableStateOf(false) }
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var confirmPassword by remember { mutableStateOf("") }

    var isLoading by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var successMessage by remember { mutableStateOf<String?>(null) }

    // Recovery code modal state
    var generatedRecoveryCode by remember { mutableStateOf<String?>(null) }
    var showRecoveryDialog by remember { mutableStateOf(false) }
    var recoverySuccessPlayer by remember { mutableStateOf<AuthUser?>(null) }

    // Recover account modal state
    var showForgotModal by remember { mutableStateOf(false) }
    var recoveryInputCode by remember { mutableStateOf("") }
    var recoveryNewPassword by remember { mutableStateOf("") }
    var recoveryError by remember { mutableStateOf<String?>(null) }
    var recoverySuccessMsg by remember { mutableStateOf<String?>(null) }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF0F172A)),
        contentAlignment = Alignment.Center
    ) {
        Column(
            modifier = Modifier
                .widthIn(max = 440.dp)
                .fillMaxWidth(0.92f)
                .padding(16.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(Color(0xFF1E293B))
                .border(2.dp, Color(0xFF334155), RoundedCornerShape(16.dp))
                .verticalScroll(rememberScrollState())
                .padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            // Header / Logo
            Text(
                text = "🌱 GROWPIXEL",
                color = Color(0xFF4ADE80),
                fontSize = 26.sp,
                fontWeight = FontWeight.Black,
                letterSpacing = 2.sp
            )
            Text(
                text = "RETRO MULTIPLAYER SANDBOX",
                color = Color(0xFF94A3B8),
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.sp,
                modifier = Modifier.padding(top = 4.dp, bottom = 20.dp)
            )

            // Mode Tabs (LOGIN / REGISTER)
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(8.dp))
                    .background(Color(0xFF0F172A))
                    .padding(4.dp),
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(6.dp))
                        .background(if (!isRegisterMode) Color(0xFF2563EB) else Color.Transparent)
                        .clickable {
                            isRegisterMode = false
                            errorMessage = null
                            successMessage = null
                        }
                        .padding(vertical = 10.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = "LOGIN",
                        color = if (!isRegisterMode) Color.White else Color(0xFF94A3B8),
                        fontWeight = FontWeight.Bold,
                        fontSize = 13.sp
                    )
                }

                Box(
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(6.dp))
                        .background(if (isRegisterMode) Color(0xFF16A34A) else Color.Transparent)
                        .clickable {
                            isRegisterMode = true
                            errorMessage = null
                            successMessage = null
                        }
                        .padding(vertical = 10.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = "REGISTER",
                        color = if (isRegisterMode) Color.White else Color(0xFF94A3B8),
                        fontWeight = FontWeight.Bold,
                        fontSize = 13.sp
                    )
                }
            }

            Spacer(modifier = Modifier.height(16.dp))

            // Error & Success alerts
            errorMessage?.let { err ->
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .background(Color(0xFF7F1D1D))
                        .border(1.dp, Color(0xFFDC2626), RoundedCornerShape(8.dp))
                        .padding(10.dp)
                ) {
                    Text(
                        text = err,
                        color = Color(0xFFFECACA),
                        fontSize = 12.sp,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth()
                    )
                }
                Spacer(modifier = Modifier.height(12.dp))
            }

            successMessage?.let { msg ->
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .background(Color(0xFF14532D))
                        .border(1.dp, Color(0xFF22C55E), RoundedCornerShape(8.dp))
                        .padding(10.dp)
                ) {
                    Text(
                        text = msg,
                        color = Color(0xFFBBF7D0),
                        fontSize = 12.sp,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth()
                    )
                }
                Spacer(modifier = Modifier.height(12.dp))
            }

            // Username input
            OutlinedTextField(
                value = username,
                onValueChange = {
                    if (it.length <= 16) username = it
                },
                label = { Text("Username") },
                placeholder = { Text("3-16 characters") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Ascii,
                    imeAction = ImeAction.Next
                ),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedTextColor = Color.White,
                    unfocusedTextColor = Color(0xFFCBD5E1),
                    focusedContainerColor = Color(0xFF0F172A),
                    unfocusedContainerColor = Color(0xFF0F172A),
                    focusedBorderColor = Color(0xFF38BDF8),
                    unfocusedBorderColor = Color(0xFF475569),
                    focusedLabelColor = Color(0xFF38BDF8),
                    unfocusedLabelColor = Color(0xFF94A3B8)
                ),
                modifier = Modifier.fillMaxWidth()
            )

            Spacer(modifier = Modifier.height(12.dp))

            // Password input
            OutlinedTextField(
                value = password,
                onValueChange = { password = it },
                label = { Text("Password") },
                placeholder = { Text("Min 8 characters") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Password,
                    imeAction = if (isRegisterMode) ImeAction.Next else ImeAction.Done
                ),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedTextColor = Color.White,
                    unfocusedTextColor = Color(0xFFCBD5E1),
                    focusedContainerColor = Color(0xFF0F172A),
                    unfocusedContainerColor = Color(0xFF0F172A),
                    focusedBorderColor = Color(0xFF38BDF8),
                    unfocusedBorderColor = Color(0xFF475569),
                    focusedLabelColor = Color(0xFF38BDF8),
                    unfocusedLabelColor = Color(0xFF94A3B8)
                ),
                modifier = Modifier.fillMaxWidth()
            )

            // Confirm Password input (REGISTER mode only)
            if (isRegisterMode) {
                Spacer(modifier = Modifier.height(12.dp))
                OutlinedTextField(
                    value = confirmPassword,
                    onValueChange = { confirmPassword = it },
                    label = { Text("Confirm Password") },
                    placeholder = { Text("Re-enter your password") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Password,
                        imeAction = ImeAction.Done
                    ),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedTextColor = Color.White,
                        unfocusedTextColor = Color(0xFFCBD5E1),
                        focusedContainerColor = Color(0xFF0F172A),
                        unfocusedContainerColor = Color(0xFF0F172A),
                        focusedBorderColor = Color(0xFF38BDF8),
                        unfocusedBorderColor = Color(0xFF475569),
                        focusedLabelColor = Color(0xFF38BDF8),
                        unfocusedLabelColor = Color(0xFF94A3B8)
                    ),
                    modifier = Modifier.fillMaxWidth()
                )
            }

            Spacer(modifier = Modifier.height(20.dp))

            // Action Button
            Button(
                onClick = {
                    if (isLoading) return@Button
                    errorMessage = null
                    successMessage = null

                    coroutineScope.launch {
                        isLoading = true
                        if (isRegisterMode) {
                            val res = authManager.registerPlayer(
                                username = username,
                                password = password,
                                confirmPassword = confirmPassword
                            )
                            isLoading = false
                            res.onSuccess { reg ->
                                successMessage = "Account created for ${reg.user.username}!"
                                if (reg.recoveryCode.isNotBlank()) {
                                    generatedRecoveryCode = reg.recoveryCode
                                    recoverySuccessPlayer = reg.user
                                    showRecoveryDialog = true
                                } else {
                                    onAuthSuccess(reg.user)
                                }
                            }.onFailure { err ->
                                errorMessage = err.message ?: "Registration failed."
                            }
                        } else {
                            val res = authManager.loginPlayer(
                                username = username,
                                password = password
                            )
                            isLoading = false
                            res.onSuccess { login ->
                                successMessage = "Welcome back, ${login.user.username}!"
                                onAuthSuccess(login.user)
                            }.onFailure { err ->
                                errorMessage = err.message ?: "Invalid username or password."
                            }
                        }
                    }
                },
                enabled = !isLoading,
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (isRegisterMode) Color(0xFF16A34A) else Color(0xFF2563EB)
                ),
                shape = RoundedCornerShape(8.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(48.dp)
            ) {
                if (isLoading) {
                    CircularProgressIndicator(
                        color = Color.White,
                        strokeWidth = 2.dp,
                        modifier = Modifier.size(20.dp)
                    )
                } else {
                    Text(
                        text = if (isRegisterMode) "CREATE GROWPIXEL ACCOUNT" else "ENTER GROWPIXEL WORLD",
                        fontWeight = FontWeight.Bold,
                        fontSize = 13.sp,
                        letterSpacing = 1.sp
                    )
                }
            }

            // Forgot password / Recovery link
            if (!isRegisterMode) {
                Spacer(modifier = Modifier.height(14.dp))
                Text(
                    text = "Lost access? Use Recovery Code",
                    color = Color(0xFF38BDF8),
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Medium,
                    modifier = Modifier
                        .clickable {
                            recoveryError = null
                            recoverySuccessMsg = null
                            recoveryInputCode = ""
                            recoveryNewPassword = ""
                            showForgotModal = true
                        }
                        .padding(4.dp)
                )
            }
        }

        // Post-Registration One-Time Recovery Code Dialog
        if (showRecoveryDialog && generatedRecoveryCode != null) {
            AlertDialog(
                onDismissRequest = { /* Require deliberate acknowledgment */ },
                title = {
                    Text(
                        "🛡️ ONE-TIME RECOVERY CODE",
                        fontWeight = FontWeight.Black,
                        fontSize = 16.sp,
                        color = Color(0xFFF59E0B)
                    )
                },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(
                            "Please save this recovery code in a secure location. If you forget your password, this is the ONLY way to recover your account.",
                            color = Color(0xFFCBD5E1),
                            fontSize = 13.sp
                        )
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(8.dp))
                                .background(Color(0xFF0F172A))
                                .border(1.dp, Color(0xFFF59E0B), RoundedCornerShape(8.dp))
                                .padding(12.dp),
                            contentAlignment = Alignment.Center
                        ) {
                            Text(
                                text = generatedRecoveryCode ?: "",
                                color = Color(0xFFFDE047),
                                fontFamily = FontFamily.Monospace,
                                fontWeight = FontWeight.Bold,
                                fontSize = 14.sp
                            )
                        }
                    }
                },
                confirmButton = {
                    Button(
                        onClick = {
                            showRecoveryDialog = false
                            recoverySuccessPlayer?.let { onAuthSuccess(it) }
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF16A34A))
                    ) {
                        Text("I HAVE SAVED MY CODE")
                    }
                },
                dismissButton = {
                    OutlinedButton(
                        onClick = {
                            val clipboard =
                                context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                            val clip = ClipData.newPlainText("GrowPixel Recovery Code", generatedRecoveryCode)
                            clipboard.setPrimaryClip(clip)
                        }
                    ) {
                        Text("COPY CODE")
                    }
                },
                containerColor = Color(0xFF1E293B)
            )
        }

        // Account Recovery Modal
        if (showForgotModal) {
            AlertDialog(
                onDismissRequest = { showForgotModal = false },
                title = {
                    Text(
                        "🔑 ACCOUNT RECOVERY",
                        fontWeight = FontWeight.Bold,
                        color = Color(0xFF38BDF8)
                    )
                },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        recoveryError?.let { err ->
                            Text(err, color = Color(0xFFEF4444), fontSize = 12.sp)
                        }
                        recoverySuccessMsg?.let { msg ->
                            Text(msg, color = Color(0xFF22C55E), fontSize = 12.sp)
                        }
                        OutlinedTextField(
                            value = recoveryInputCode,
                            onValueChange = { recoveryInputCode = it },
                            label = { Text("Recovery Code") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth()
                        )
                        OutlinedTextField(
                            value = recoveryNewPassword,
                            onValueChange = { recoveryNewPassword = it },
                            label = { Text("New Password (min 8 chars)") },
                            visualTransformation = PasswordVisualTransformation(),
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth()
                        )
                    }
                },
                confirmButton = {
                    Button(
                        onClick = {
                            coroutineScope.launch {
                                recoveryError = null
                                recoverySuccessMsg = null
                                val res = authManager.recoverPlayer(recoveryInputCode, recoveryNewPassword)
                                res.onSuccess {
                                    recoverySuccessMsg = "Password reset! You may now login."
                                }.onFailure { err ->
                                    recoveryError = err.message ?: "Recovery failed."
                                }
                            }
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF2563EB))
                    ) {
                        Text("RESET PASSWORD")
                    }
                },
                dismissButton = {
                    TextButton(onClick = { showForgotModal = false }) {
                        Text("CANCEL", color = Color(0xFF94A3B8))
                    }
                },
                containerColor = Color(0xFF1E293B)
            )
        }
    }
}
