import torch


def main() -> None:
    torch.manual_seed(42)

    # Synthetic data: y = 3x + 2 + noise
    x = torch.linspace(-1, 1, 200).unsqueeze(1)
    noise = 0.1 * torch.randn_like(x)
    y = 3.0 * x + 2.0 + noise

    model = torch.nn.Linear(1, 1)
    optimizer = torch.optim.SGD(model.parameters(), lr=0.1)
    loss_fn = torch.nn.MSELoss()

    for epoch in range(1, 201):
        optimizer.zero_grad()
        preds = model(x)
        loss = loss_fn(preds, y)
        loss.backward()
        optimizer.step()

        if epoch % 50 == 0:
            w = model.weight.item()
            b = model.bias.item()
            print(f"epoch {epoch:3d} | loss {loss.item():.6f} | w {w:.3f} | b {b:.3f}")

    print("\nFinal parameters:")
    print(f"weight: {model.weight.item():.4f}")
    print(f"bias:   {model.bias.item():.4f}")


if __name__ == "__main__":
    main()
