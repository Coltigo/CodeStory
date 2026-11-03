from report import describe_quality


def main():
    # Use demonstration text, never a real password in an AI upload.
    sample = "Example!928"
    print(describe_quality(sample))


if __name__ == "__main__":
    main()
