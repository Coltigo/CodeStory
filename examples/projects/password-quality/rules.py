def check_quality(password):
    # Educational checks, not a guarantee that a password is secure.
    return {
        "long_enough": len(password) >= 12,
        "has_uppercase": any(char.isupper() for char in password),
        "has_lowercase": any(char.islower() for char in password),
        "has_digit": any(char.isdigit() for char in password),
    }
