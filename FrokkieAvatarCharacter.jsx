import React, { useRef, useEffect, useState } from "react";

const FrokkieAvatarCharacter = ({ isLoading = false, isResponding = false }) => {
  const canvasRef = useRef(null);
  const [animationState, setAnimationState] = useState("idle");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    const width = canvas.width;
    const height = canvas.height;
    let frameCount = 0;

    const drawFrikkie = () => {
      ctx.clearRect(0, 0, width, height);

      // Calculate animation offset
      const time = Date.now() * 0.001;
      const bobOffset = Math.sin(time) * 8; // Gentle bobbing
      const headTilt = Math.sin(time * 0.5) * 3; // Gentle head tilt

      const centerX = width / 2;
      const centerY = height / 2 + bobOffset;

      // Save context for transforms
      ctx.save();
      ctx.translate(centerX, centerY);
      ctx.rotate((headTilt * Math.PI) / 180);
      ctx.translate(-centerX, -centerY);

      // Skin tone
      const skinColor = "#C9956F";

      // Draw body (khaki shirt)
      ctx.fillStyle = "#D4B896";
      ctx.fillRect(centerX - 70, centerY + 40, 140, 120);

      // Chest pocket details
      ctx.strokeStyle = "#A89968";
      ctx.lineWidth = 2;
      ctx.strokeRect(centerX - 20, centerY + 50, 25, 35);
      ctx.strokeRect(centerX + 10, centerY + 50, 25, 35);

      // 4x4 Factory logo on shirt
      ctx.fillStyle = "#8B4513";
      ctx.font = "bold 14px Arial";
      ctx.textAlign = "center";
      ctx.fillText("4×4", centerX, centerY + 75);
      ctx.font = "10px Arial";
      ctx.fillText("FACTORY", centerX, centerY + 90);

      // Jeans/pants
      ctx.fillStyle = "#5C4033";
      ctx.fillRect(centerX - 70, centerY + 160, 140, 80);

      // Arms
      ctx.fillStyle = skinColor;
      ctx.beginPath();
      ctx.ellipse(centerX - 70, centerY + 70, 15, 50, -0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(centerX + 70, centerY + 70, 15, 50, 0.3, 0, Math.PI * 2);
      ctx.fill();

      // Hands
      ctx.fillStyle = skinColor;
      ctx.beginPath();
      ctx.arc(centerX - 75, centerY + 120, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(centerX + 75, centerY + 120, 12, 0, Math.PI * 2);
      ctx.fill();

      // Left hand holding pipe
      ctx.fillStyle = "#8B4513";
      ctx.beginPath();
      ctx.ellipse(centerX - 75, centerY + 95, 8, 20, -0.4, 0, Math.PI * 2);
      ctx.fill();

      // Tobacco pipe
      const pipeX = centerX - 40;
      const pipeY = centerY - 15 + (Math.sin(time * 2) * 2); // Pipe wobbles

      ctx.strokeStyle = "#8B5A2B";
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.arc(pipeX, pipeY, 12, 0, Math.PI * 2);
      ctx.stroke();

      // Pipe stem
      ctx.strokeStyle = "#8B5A2B";
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.quadraticCurveTo(pipeX + 15, pipeY + 5, pipeX + 30, pipeY - 10);
      ctx.stroke();

      // Pipe smoke
      if (!isLoading) {
        ctx.fillStyle = "rgba(150, 150, 150, 0.3)";
        ctx.beginPath();
        ctx.arc(
          pipeX + 35 + Math.sin(time * 3) * 5,
          pipeY - 20 + Math.cos(time * 2.5) * 5,
          12,
          0,
          Math.PI * 2
        );
        ctx.fill();

        ctx.fillStyle = "rgba(180, 180, 180, 0.2)";
        ctx.beginPath();
        ctx.arc(
          pipeX + 45 + Math.sin(time * 2.8 + 1) * 8,
          pipeY - 35 + Math.cos(time * 2.3) * 8,
          15,
          0,
          Math.PI * 2
        );
        ctx.fill();
      }

      // Head
      ctx.fillStyle = skinColor;
      ctx.beginPath();
      ctx.arc(centerX, centerY - 40, 45, 0, Math.PI * 2);
      ctx.fill();

      // Hat (weathered cowboy/4x4 hat)
      ctx.fillStyle = "#8B7355";
      ctx.beginPath();
      ctx.ellipse(centerX, centerY - 85, 50, 20, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#7A6A4E";
      ctx.beginPath();
      ctx.moveTo(centerX - 50, centerY - 85);
      ctx.quadraticCurveTo(centerX - 55, centerY - 90, centerX - 50, centerY - 95);
      ctx.quadraticCurveTo(centerX, centerY - 100, centerX + 50, centerY - 95);
      ctx.quadraticCurveTo(centerX + 55, centerY - 90, centerX + 50, centerY - 85);
      ctx.closePath();
      ctx.fill();

      // Hat band
      ctx.fillStyle = "#654321";
      ctx.fillRect(centerX - 50, centerY - 80, 100, 8);

      // Weathered hat texture
      ctx.strokeStyle = "rgba(0, 0, 0, 0.1)";
      ctx.lineWidth = 1;
      for (let i = 0; i < 5; i++) {
        ctx.beginPath();
        ctx.arc(
          centerX - 40 + i * 20,
          centerY - 85 + Math.sin(i) * 3,
          35 + i * 2,
          0,
          Math.PI * 2
        );
        ctx.stroke();
      }

      // Eyes
      ctx.fillStyle = "#333333";
      const eyeY = centerY - 50;
      const eyeLeftX = centerX - 18;
      const eyeRightX = centerX + 18;

      // Eye movement based on animation
      const eyeMovement = Math.sin(time * 2) * 3;

      ctx.beginPath();
      ctx.arc(eyeLeftX + eyeMovement, eyeY, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(eyeRightX + eyeMovement, eyeY, 8, 0, Math.PI * 2);
      ctx.fill();

      // Eye shine
      ctx.fillStyle = "#FFFFFF";
      ctx.beginPath();
      ctx.arc(eyeLeftX + eyeMovement + 2, eyeY - 2, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(eyeRightX + eyeMovement + 2, eyeY - 2, 3, 0, Math.PI * 2);
      ctx.fill();

      // Eyebrows - expressive!
      ctx.strokeStyle = "#654321";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(eyeLeftX, eyeY - 12, 12, 0.2, 0.8);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(eyeRightX, eyeY - 12, 12, Math.PI - 0.8, Math.PI - 0.2);
      ctx.stroke();

      // Weathered face wrinkles
      ctx.strokeStyle = "rgba(0, 0, 0, 0.1)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(centerX - 35, centerY - 30);
      ctx.quadraticCurveTo(centerX - 30, centerY - 25, centerX - 25, centerY - 30);
      ctx.stroke();

      // Mouth - Big friendly mustache
      ctx.strokeStyle = "#654321";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(centerX - 20, centerY - 10);
      ctx.quadraticCurveTo(centerX, centerY - 5, centerX + 20, centerY - 10);
      ctx.stroke();

      // Smile under mustache
      ctx.strokeStyle = "#A0714F";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(centerX, centerY - 5, 15, 0, Math.PI);
      ctx.stroke();

      // Beard/stubble
      ctx.fillStyle = "rgba(101, 67, 33, 0.3)";
      ctx.fillRect(centerX - 35, centerY - 5, 70, 20);

      ctx.restore();

      // Draw pipe smoke animation when responding
      if (isResponding) {
        const smokeColors = [
          "rgba(200, 200, 200, 0.4)",
          "rgba(220, 220, 220, 0.3)",
          "rgba(240, 240, 240, 0.2)",
        ];

        for (let i = 0; i < 3; i++) {
          const x =
            centerX + 20 + Math.sin(time * (2 + i * 0.5)) * 15 + i * 5;
          const y = centerY - 80 - time * 50 - i * 30;

          ctx.fillStyle = smokeColors[i];
          ctx.beginPath();
          ctx.arc(x, y, 15 + i * 5, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Loading indicator (thinking/processing)
      if (isLoading) {
        ctx.fillStyle = "rgba(255, 107, 53, 0.8)";
        ctx.font = "bold 20px Arial";
        ctx.textAlign = "center";
        ctx.fillText("💭", centerX - 60, centerY - 120);

        // Animated thinking dots
        ctx.fillStyle = "#FF6B35";
        for (let i = 0; i < 3; i++) {
          const dotOffset = ((frameCount + i * 10) % 30) / 30;
          ctx.globalAlpha = Math.max(0, 1 - dotOffset * 2);
          ctx.beginPath();
          ctx.arc(centerX - 45 + i * 10, centerY - 125 + dotOffset * 20, 3, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      frameCount++;
      requestAnimationFrame(drawFrikkie);
    };

    drawFrikkie();
  }, [isLoading, isResponding]);

  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center" }}>
      <canvas
        ref={canvasRef}
        width={300}
        height={400}
        style={{
          display: "block",
          maxWidth: "100%",
          height: "auto",
          filter: isLoading ? "brightness(0.9)" : "brightness(1)",
          transition: "filter 0.3s ease",
        }}
      />
    </div>
  );
};

export default FrokkieAvatarCharacter;
